#!/usr/bin/env node
/**
 * @file scripts/testing/run-fixed-height-translation-test.cjs
 * 使用生产扩展和本地确定性翻译响应验证 OpenRouter 风格固定高度模型卡片：多个译文
 * 共用卡片时不得溢出或重叠，独立滚动容器不得被翻译内容撑开，宿主样式变更应保留，
 * 并且 Alt+T 必须支持翻译、恢复和再次翻译。浏览器始终使用临时 profile 和 focus-safe helper。
 */
const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const {controlledProviderRuntime} = require('../site-translation/controlled-provider.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');

const root = path.resolve(__dirname, '../..');
const owned = '.fluent-read-bilingual-content';
const sourceSelectors = ['.model-title', '.model-description', '.model-meta'];

function parseArgs(argv) {
  const args = {helperPath: path.join(__dirname, 'focus-safe-browser.cjs'), timeout: 30000, display: 'secondary', browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
  const names = {'--extension-dir': 'extensionDir', '--playwright-root': 'playwrightRoot', '--focus-safe-helper': 'helperPath', '--artifacts-dir': 'artifactsDir', '--timeout': 'timeout', '--display': 'display', '--browser-path': 'browserPath'};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--background') continue;
    assert.ok(names[key] && argv[i + 1] && !argv[i + 1].startsWith('--'), `无法识别参数或缺少值：${key}`);
    args[names[key]] = argv[++i];
  }
  for (const key of ['extensionDir', 'playwrightRoot', 'helperPath', 'artifactsDir']) assert.ok(args[key], `缺少 --${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
  args.timeout = Number(args.timeout);
  assert.ok(Number.isFinite(args.timeout) && args.timeout >= 5000, '--timeout 必须至少为 5000 ms');
  for (const key of ['extensionDir', 'playwrightRoot', 'helperPath', 'artifactsDir']) args[key] = path.resolve(args[key]);
  return args;
}

/** 实际页面完成条件：延迟 spinner 的空窗不等于三张卡片的九个文本槽已完成。 */
function isFixedHeightTranslationSettled({owned, sourceSelectors}) {
  if (document.querySelector('.fluent-read-loading, .fluent-read-retry-wrapper')) return false;
  const cards = [...document.querySelectorAll('.model-card')];
  return cards.length === 3 && document.querySelectorAll(owned).length === 9 && cards.every(card =>
    card.querySelectorAll(owned).length >= 3 && sourceSelectors.every(selector => {
      const sources = card.querySelectorAll(selector);
      return sources.length === 1 && sources[0].querySelectorAll(owned).length === 1;
    }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertFreshProductionExtension(args.extensionDir, root);
  fs.mkdirSync(args.artifactsDir, {recursive: true});
  const helper = require(args.helperPath);
  for (const name of ['launchFocusSafePersistentContext', 'newPageWithoutForeground', 'activateExtensionTabWithoutForeground']) assert.equal(typeof helper[name], 'function', `focus-safe helper 缺少 ${name}`);
  const {chromium} = createRequire(path.join(args.playwrightRoot, 'fixed-height-test.cjs'))('playwright');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-fixed-height-'));
  const report = {scope: 'openrouter-fixed-height-local-fixture', provider: 'microsoft-local-deterministic-response', evidenceType: 'production-extension-equivalent-fixture', profileMode: 'new-temporary-profile', cases: [], errors: [], screenshots: []};
  const save = () => fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  let session, primaryError;
  try {
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir, browserPath: args.browserPath, background: true, headless: false, displayTarget: args.display, timeout: args.timeout, viewport: {width: 1280, height: 900}, browserArgs: [`--disable-extensions-except=${args.extensionDir}`, `--load-extension=${args.extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir);
    const context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: args.timeout});
    const installWorker = current => current.evaluate(controlledProviderRuntime, true).then(() => current.evaluate(() => {
      globalThis.fixedHeightRequests = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') throw new Error(`External worker fetch disabled: ${url.origin}`);
        const texts = JSON.parse(init?.body ?? await input.text());
        globalThis.fixedHeightRequests.push(texts);
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text: globalThis.__frCompatibilityTransport.encode(text, 'microsoft-escaped-text')}]}))), {status: 200, headers: {'content-type': 'application/json'}});
      };
    }));
    await installWorker(worker);
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/fixed-height-translation-fixture.html'), 'utf8');
    const url = 'https://openrouter.ai/provider/minimax-fixed-height-fixture';
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest() && route.request().url() === url) return route.fulfill({status: 200, contentType: 'text/html', body: fixture});
      if (/^https?:/u.test(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    const control = await helper.newPageWithoutForeground(context, args.timeout);
    const extensionId = new URL(worker.url()).host;
    await control.goto(`chrome-extension://${extensionId}/popup.html`, {waitUntil: 'domcontentloaded'});
    await control.waitForTimeout(500);
    const config = await control.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      const next = {...current, on: true, service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'all', translationScope: 'all', useCache: false, enableAIContext: false, enableAIMultiSegment: false, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true};
      return chrome.runtime.sendMessage({type: 'persistConfig', config: next, clientId: 'fixed-height-browser-test', sequence: Date.now(), baseRevision: current.__fluentConfigRevision});
    });
    assert.equal(config.success, true, JSON.stringify(config));
    report.config = {service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'all', translationScope: 'all', useCache: false, enableAIContext: false, enableAIMultiSegment: false};
    const page = await helper.newPageWithoutForeground(context, args.timeout);
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: args.timeout});
    await page.waitForTimeout(600);
    const snapshot = async label => page.evaluate(({label, owned, sourceSelectors}) => {
      const rect = selector => { const n = document.querySelector(selector); return n ? {selector, ...(() => { const r = n.getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height}; })()} : null; };
      const cards = [...document.querySelectorAll('.model-card')].map(card => ({id: card.id, rect: rect(`#${card.id}`), innerRects: [...card.querySelectorAll('.model-inner')].map(node => { const r = node.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, height: r.height}; }), wrappers: card.querySelectorAll(owned).length, sources: sourceSelectors.map(selector => ({selector, count: card.querySelectorAll(selector).length, wrappers: [...card.querySelectorAll(selector)].reduce((n, node) => n + node.querySelectorAll(owned).length, 0)})), className: card.className, style: card.getAttribute('style'), html: card.innerHTML}));
      const container = document.querySelector('#model-scroll');
      return {label, url: location.href, cards, container: {clientHeight: container.clientHeight, scrollHeight: container.scrollHeight, rect: rect('#model-scroll')}, neighborWrappers: document.querySelectorAll(`#outside-neighbor ${owned}`).length, totalWrappers: document.querySelectorAll(owned).length, nested: document.querySelectorAll(`${owned} ${owned}`).length, title: document.querySelector('#fixture-title')?.textContent};
    }, {label, owned, sourceSelectors});
    const screenshot = async label => { const target = path.join(args.artifactsDir, `${label}.png`); await page.screenshot({path: target, fullPage: true}); report.screenshots.push(target); };
    const toggle = async () => { await helper.activateExtensionTabWithoutForeground(context, page); await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt'); };
    const waitSettled = () => page.waitForFunction(isFixedHeightTranslationSettled, {owned, sourceSelectors}, {timeout: args.timeout});
    const result = {id: 'fixed-height-card-layout', counts: [], hostStylePreserved: false, scrollContainerPreserved: false}; report.cases.push(result);
    result.before = await snapshot('before'); await screenshot('fixed-height-before');
    await helper.activateExtensionTabWithoutForeground(context, page);
    const hoverTarget = page.locator('#card-a .model-description');
    await hoverTarget.scrollIntoViewIfNeeded();
    const hoverBox = await hoverTarget.boundingBox();
    assert.ok(hoverBox, 'Control 悬浮翻译目标不可见');
    await page.mouse.move(0, 0);
    await page.mouse.move(hoverBox.x + Math.min(16, hoverBox.width / 2), hoverBox.y + Math.min(14, hoverBox.height / 2), {steps: 3});
    await page.waitForFunction(() => document.querySelector('#card-a .model-description')?.matches(':hover') === true, undefined, {timeout: args.timeout});
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('#card-a .model-description .fluent-read-bilingual-content').length === 1, undefined, {timeout: args.timeout});
    result.hover = await snapshot('control-hover-translated');
    assert.equal(result.hover.neighborWrappers, 0);
    assert.equal(result.hover.nested, 0);
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0, undefined, {timeout: args.timeout});
    result.hoverRestored = await snapshot('control-hover-restored');
    await helper.activateExtensionTabWithoutForeground(context, page);
    await page.mouse.move(hoverBox.x + Math.min(16, hoverBox.width / 2), hoverBox.y + Math.min(14, hoverBox.height / 2), {steps: 2});
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('#card-a .model-description .fluent-read-bilingual-content').length === 1, undefined, {timeout: args.timeout});
    result.hoverRetranslated = await snapshot('control-hover-retranslated');
    const hoverInnerLayout = await page.evaluate(() => [...document.querySelectorAll('.model-card')].map(card => { const shell = card.getBoundingClientRect(); return [...card.querySelectorAll('.model-inner')].every(inner => { const r = inner.getBoundingClientRect(); return r.top >= shell.top - 0.5 && r.bottom <= shell.bottom + 0.5; }); }));
    assert.ok(hoverInnerLayout.every(Boolean), 'Control retranslation produced inner content outside card bounds');
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0, undefined, {timeout: args.timeout});
    await toggle(); await waitSettled(); await page.waitForTimeout(700);
    result.first = await snapshot('translated'); result.counts.push(result.first.totalWrappers); await screenshot('fixed-height-translated');
    await page.evaluate(() => {
      const card = document.querySelector('#card-b');
      card.classList.add('host-style-sentinel');
      card.style.setProperty('height', '220px');
      card.style.setProperty('border-left', '7px solid rgb(217, 119, 6)');
    });
    // 全文会话对宿主属性采用有界 debounce；等待真实布局收敛，不能在 500ms 复验前采样。
    await page.waitForFunction(() => document.querySelector('#card-b').style.height === 'auto', undefined, {timeout: args.timeout});
    result.styled = await snapshot('styled');
    result.hostStylePreserved = await page.evaluate(() => {
      const card = document.querySelector('#card-b');
      return card.classList.contains('host-style-sentinel') && card.style.borderLeft === '7px solid rgb(217, 119, 6)';
    });
    result.scrollContainerPreserved = result.styled.container.clientHeight === result.before.container.clientHeight && result.styled.container.rect.width === result.before.container.rect.width && result.styled.container.rect.height === result.before.container.rect.height;
    const overlap = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.model-card')];
      const innerRects = cards.flatMap(card => [...card.querySelectorAll('.model-inner')].map(inner => ({card, rect: inner.getBoundingClientRect()})));
      return innerRects.some(({card, rect}) => { const shell = card.getBoundingClientRect(); return rect.top < shell.top - 0.5 || rect.bottom > shell.bottom + 0.5; }) ||
        innerRects.some((a, i) => innerRects.slice(i + 1).some(b => a.card !== b.card && a.rect.bottom > b.rect.top + 0.5 && b.rect.bottom > a.rect.top + 0.5));
    });
    result.overlap = overlap;
    assert.equal(result.first.cards.length, 3);
    assert.equal(result.first.cards.reduce((n, card) => n + card.wrappers, 0), result.first.totalWrappers);
    assert.ok(result.first.cards.every(card => card.wrappers >= 3), 'each card must contain multiple shared translations');
    assert.equal(result.first.neighborWrappers, 0);
    assert.equal(result.first.nested, 0);
    assert.equal(result.overlap, false, 'translated model cards overlap');
    assert.equal(result.hostStylePreserved, true);
    assert.equal(result.scrollContainerPreserved, true, 'translation changed independent scroll container geometry');
    await toggle(); await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0, undefined, {timeout: args.timeout}); await page.waitForTimeout(300);
    result.restored = await snapshot('restored'); result.counts.push(result.restored.totalWrappers);
    assert.equal(result.restored.totalWrappers, 0); assert.equal(result.restored.url, url); assert.equal(result.restored.title, result.before.title);
    assert.equal(result.restored.cards[1].className, result.styled.cards[1].className);
    assert.equal(await page.locator('#card-b').evaluate(card => card.style.height), '220px');
    assert.equal(await page.locator('#card-b').evaluate(card => card.style.borderLeft), '7px solid rgb(217, 119, 6)');
    assert.equal(result.restored.cards[0].rect.height, 176);
    assert.equal(result.restored.cards[2].rect.height, 176);
    await toggle(); await waitSettled(); await page.waitForTimeout(700);
    result.retranslated = await snapshot('retranslated'); result.counts.push(result.retranslated.totalWrappers); await screenshot('fixed-height-retranslated');
    assert.deepEqual(result.counts, [result.first.totalWrappers, 0, result.first.totalWrappers]);
    assert.equal(result.retranslated.nested, 0); assert.equal(result.retranslated.neighborWrappers, 0);
    result.retranslatedLayout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.model-card')];
      const inners = cards.flatMap(card => [...card.querySelectorAll('.model-inner')].map(inner => ({card, rect: inner.getBoundingClientRect()})));
      return inners.every(({card, rect}) => { const shell = card.getBoundingClientRect(); return rect.top >= shell.top - 0.5 && rect.bottom <= shell.bottom + 0.5; }) &&
        inners.every((a, i) => inners.slice(i + 1).every(b => a.card === b.card || a.rect.bottom <= b.rect.top + 0.5 || b.rect.bottom <= a.rect.top + 0.5));
    });
    assert.equal(result.retranslatedLayout, true, 'Alt+T retranslation produced an invalid card layout');
    result.providerRequests = await worker.evaluate(() => globalThis.fixedHeightRequests.length);
    assert.ok(result.providerRequests > 0, '确定性翻译 fixture 未收到请求');
    fs.writeFileSync(path.join(args.artifactsDir, 'live-dom.json'), JSON.stringify({before: result.before, hover: result.hover, hoverRestored: result.hoverRestored, hoverRetranslated: result.hoverRetranslated, first: result.first, styled: result.styled, restored: result.restored, retranslated: result.retranslated}, null, 2));
    result.passed = true; report.passed = true; save();
    process.stdout.write(`fixed-height-card-layout: passed; translated/restored/retranslated ${result.counts.join('/') }\n`);
  } catch (error) {
    primaryError = error;
    report.error = error.stack || String(error); throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try {await release();} catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.passed = false;
        if (resource === 'profile') report.retainedProfile = profileDir;
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => {
      if (session) {await session.close(); browserClosed = true;}
    });
    await cleanup('profile', () => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      else report.retainedProfile = profileDir;
    });
    await cleanup('report', () => {save();});
    if (report.retainedProfile) process.stderr.write(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}\n`);
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = {isFixedHeightTranslationSettled};
