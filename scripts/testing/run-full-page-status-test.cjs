/**
 * @file scripts/testing/run-full-page-status-test.cjs
 * 文件职责：在真实生产扩展中检查全文结果提示、入口显隐和会话取消的交互契约。
 * 主要内容：使用临时 Edge 后台窗口、已知正文和受控微软响应，验证加载/全部失败/成功徽标、只隐藏悬浮球时保留译文、站点名单的紧凑提示、总开关恢复、迟到响应隔离及窄屏主题。
 * 模块边界：只通过公开配置消息和真实快捷键操作扩展；CDP 只读 closed Shadow DOM，不改变组件状态，不访问用户配置或外部供应商。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
const {patchStoredConfig} = require('../run-selection-trigger-test.cjs');
const {readFloatingUiState} = require('../run-full-page-translation-test.cjs');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  assert.ok(index >= 0 && process.argv[index + 1], `缺少 --${name}`);
  return path.resolve(process.argv[index + 1]);
}
const extensionDir = arg('extension-dir');
const output = arg('artifacts-dir');
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const helper = require(arg('focus-safe-helper'));
assert.ok(!process.argv.includes('--headed'), '本专项仅允许后台隔离测试');
fs.mkdirSync(output, {recursive: true});
const report = {ok: false, scope: 'Production extension, controlled page and provider responses; full-page status, UI hiding and cancellation', cases: [], errors: [], screenshots: []};
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-full-page-status-'));
let launched;
const timeout = 30000;

function find(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}
function attribute(node, name) {
  const values = node?.attributes || [];
  for (let index = 0; index < values.length; index += 2) if (values[index] === name) return values[index + 1];
  return null;
}
async function status(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
    const ball = find(root, node => (attribute(node, 'class') || '').split(/\s/u).includes('fr-floating-ball'));
    const panel = find(root, node => (attribute(node, 'class') || '').split(/\s/u).includes('fr-translation-progress'));
    return {...await readFloatingUiState(page), translationStatus: attribute(ball, 'data-translation-status'),
      completed: Number(attribute(panel, 'data-completed')), failed: Number(attribute(panel, 'data-failed'))};
  } finally {await cdp.detach();}
}
async function waitStatus(page, predicate, label) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await status(page);
    if (predicate(value)) {report.cases.push({label, ...value}); return value;}
    await page.waitForTimeout(75);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

(async () => {
  try {
    assertFreshProductionExtension(extensionDir);
    launched = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true, headless: false, displayTarget: 'secondary', viewport: {width: 1100, height: 800},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(launched.launchMode, 'macos-background-cdp');
    assert.equal(launched.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.statusFixture = {hold: true, fail: true, requests: [], releases: []};
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') throw new Error('Unexpected provider fetch');
        const texts = JSON.parse(init?.body || await input.text());
        const fixture = globalThis.statusFixture;
        fixture.requests.push(texts);
        if (fixture.hold) await new Promise(resolve => fixture.releases.push(resolve));
        if (fixture.fail) return new Response('Invalid request', {status: 400});
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text: `测试译文：${text}`}]}))),
          {headers: {'content-type': 'application/json'}});
      };
    });
    const url = 'https://example.com/fluentread-full-page-status';
    const html = '<!doctype html><html lang="en"><head><title>Full page status</title></head><body style="font:20px sans-serif;padding:36px"><main><p id="one">The first paragraph stays readable while translation is running.</p><p id="two">The second paragraph keeps its original host element and text.</p><p id="three">The third paragraph checks recovery after a failed request.</p></main></body></html>';
    await context.route('**/*', route => {
      if (route.request().url() === url) return route.fulfill({contentType: 'text/html', body: html});
      if (/^https?:/u.test(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    const control = await helper.newPageWithoutForeground(context);
    await control.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await patchStoredConfig(control, {on: true, service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1,
      useCache: false, enableAIMultiSegment: false, enableAIContext: false, pageTitleTranslationEnabled: false,
      floatingBallHotkey: 'Alt+T', disableFloatingBall: false, floatingBallDisabledDomains: [],
      translationProgressPanelEnabled: true, fullPageTranslationMode: 'all', animations: false,
      floatingBallToolsDisplay: 'always', uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, autoTranslate: false});
    const page = await helper.newPageWithoutForeground(context);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('#fluent-read-floating-ball-container', {state: 'attached'});
    const toggle = async () => {
      await helper.activateExtensionTabWithoutForeground(context, page);
      await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
    };
    const screenshot = async name => {
      const file = path.join(output, `${name}.png`);
      await page.screenshot({path: file, caret: 'initial'});
      report.screenshots.push(file);
    };
    const release = async fail => worker.evaluate(fail => {
      const fixture = globalThis.statusFixture;
      fixture.fail = fail; fixture.hold = false;
      fixture.releases.splice(0).forEach(resolve => resolve());
    }, fail);
    await toggle();
    await page.waitForSelector('.fluent-read-loading');
    await waitStatus(page, value => value.translationStatus === 'translating' && value.translated && !value.check, 'loading has no success check');
    await screenshot('loading');
    await release(true);
    await waitStatus(page, value => value.translationStatus === 'error' && value.failed === 3 && !value.check, 'all failures have no success check');
    await screenshot('failed');
    await release(false);
    await page.locator('.fr-translation-progress button', {hasText: '重试失败项'}).click();
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 3);
    await waitStatus(page, value => value.translationStatus === 'translated' && value.checkVisible && value.failed === 0, 'successful retry shows result check');
    await screenshot('success');
    await page.evaluate(() => {window.savedFullPageWrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];});
    const beforeHide = await worker.evaluate(() => globalThis.statusFixture.requests.length);
    const preserved = () => page.evaluate(() => window.savedFullPageWrappers.every(node => node.isConnected) &&
      document.querySelectorAll('.fluent-read-bilingual-content').length === 3);
    await patchStoredConfig(control, {disableFloatingBall: true});
    await waitStatus(page, value => !value.host && value.progressCompact, 'hide floating ball preserves compact status');
    assert.equal(await preserved(), true);
    await patchStoredConfig(control, {disableFloatingBall: false});
    await waitStatus(page, value => value.host && value.translationStatus === 'translated' && value.checkVisible, 'remount receives actual success');
    assert.equal(await preserved(), true);
    await patchStoredConfig(control, {floatingBallDisabledDomains: ['example.com']});
    await waitStatus(page, value => !value.host && value.progressCompact, 'site hidden ball retains compact status');
    assert.equal(await preserved(), true);
    assert.equal(await worker.evaluate(() => globalThis.statusFixture.requests.length), beforeHide);
    await screenshot('site-hidden');
    await patchStoredConfig(control, {on: false});
    await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper'));
    report.cases.push({label: 'global switch still restores originals', translations: 0});
    await patchStoredConfig(control, {on: true, floatingBallDisabledDomains: []});
    await page.waitForSelector('#fluent-read-floating-ball-container', {state: 'attached'});
    await worker.evaluate(() => {globalThis.statusFixture.hold = true;});
    await toggle();
    await page.waitForSelector('.fluent-read-loading');
    const requestDeadline = Date.now() + timeout;
    while (!await worker.evaluate(() => globalThis.statusFixture.releases.length > 0)) {
      assert.ok(Date.now() < requestDeadline, 'No pending provider request');
      await page.waitForTimeout(50);
    }
    await toggle();
    await page.waitForFunction(() => !document.querySelector('.fluent-read-loading, .fluent-read-bilingual-content, .fluent-read-retry-wrapper'));
    await release(false);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper').count(), 0);
    await waitStatus(page, value => !value.translated && !value.check && value.translationStatus === 'idle', 'late cancelled response stays idle');
    await toggle();
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 3);
    await waitStatus(page, value => value.translationStatus === 'translated' && value.checkVisible, 'cancel then translate again');
    await patchStoredConfig(control, {theme: 'dark', uiLanguage: 'en-US'});
    await page.setViewportSize({width: 390, height: 780});
    await helper.activateExtensionTabWithoutForeground(context, page);
    await waitStatus(page, value => value.translationStatus === 'translated' && value.checkVisible, 'narrow dark English result');
    await screenshot('narrow-dark');
    await toggle();
    await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content'));
    await worker.evaluate(() => {globalThis.statusFixture.fail = true;});
    await toggle();
    await waitStatus(page, value => value.translationStatus === 'error' && value.failed === 3 && !value.check, 'narrow failure remains recoverable');
    const narrowPanel = await page.locator('.fr-translation-progress').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        dark: node.classList.contains('fr-dark'), text: node.textContent,
        actionsEnabled: [...node.querySelectorAll('.fr-progress-action')].every(button => !button.disabled)};
    });
    assert.ok(narrowPanel.dark && narrowPanel.actionsEnabled);
    assert.ok(narrowPanel.left >= 0 && narrowPanel.right <= narrowPanel.viewportWidth + 1 &&
      narrowPanel.top >= 0 && narrowPanel.bottom <= narrowPanel.viewportHeight + 1, JSON.stringify(narrowPanel));
    assert.match(narrowPanel.text, /retry/i);
    report.cases.push({label: 'narrow dark English failure panel fits viewport', ...narrowPanel});
    await screenshot('narrow-failure');
    await toggle();
    await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper'));
    assert.equal(await page.locator('main').textContent(), 'The first paragraph stays readable while translation is running.The second paragraph keeps its original host element and text.The third paragraph checks recovery after a failed request.');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {report.failure = error.stack || String(error); process.exitCode = 1;}
  finally {
    if (launched) {
      try {await launched.close(); await fs.promises.rm(profileDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 150});}
      catch (error) {report.ok = false; report.cleanupError = String(error); process.exitCode = 1;}
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, output, failure: report.failure, cleanupError: report.cleanupError}));
  }
})();
