#!/usr/bin/env node
'use strict';
// 免费翻译智能加速生产专项：临时 Edge、真实 Control 手势、受控 HTTP 故障与配置持久化。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const live = process.argv.includes('--live');
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-free-routing-browser'));
  const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper'));
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-free-routing-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end('<!doctype html><html lang="en"><head><title>Free routing fixture</title></head><body style="max-width:760px;margin:80px auto;font:22px/1.8 sans-serif"><h1>Free translation routing</h1><p id="primary">The software translates this paragraph with a fast backup when the first service is slow.</p><p id="baseline">This separate paragraph measures waiting for the first service timeout in priority mode.</p><p id="failure">This paragraph checks that unavailable services do not restart the entire translation process.</p><p id="neighbor">This neighboring paragraph must remain unchanged throughout the test.</p></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const report = {ok: false, extensionDir, profileDir, evidenceBoundary: live ? 'Real enabled free providers on one synthetic English paragraph; the page is local, responses are live, and a single run does not prove general latency or availability.' : 'Production extension with synthetic HTTP responses. This verifies scheduling and UI, not external provider performance.', screenshots: [], pageErrors: []};
  let launched, currentPage;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const extensionOrigin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    const createPage = async url => {
      const page = await newPageWithoutForeground(context, 30000);
      currentPage = page;
      page.on('pageerror', error => report.pageErrors.push(error.message));
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      return page;
    };
    const popup = await createPage(`${extensionOrigin}/popup.html`);
    const readConfig = () => popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!response?.success) throw new Error('config read failed');
      return typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
    });
    for (let i = 0; i < 100 && !(await readConfig())?.service; i++) await wait(100);
    const patch = {uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, service: 'freeTranslation', from: 'en', to: 'zh-Hans',
      freeTranslationMode: 'balanced', freeTranslationOrder: live ? ['microsoft', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'deeplx', 'myMemory'] : ['microsoft', 'transmart'], freeTranslationTimeoutMs: 5000,
      translationMaxRetries: 3, display: 1, useCache: true, autoTranslate: false, hotkey: 'Control', mouseHoverTranslationDelay: 0,
      selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, floatingBall: false, enableAIContext: false, glossaryEnabled: false};
    const existing = await readConfig();
    const saved = await popup.evaluate(async ({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch,
      expected, clientId: `free-routing-${crypto.randomUUID()}`, sequence: 1}), {patch, expected: Object.fromEntries(Object.keys(patch).map(key => [key, existing[key]]))});
    assert.equal(saved.success, true);
    for (let i = 0; i < 100 && (await readConfig()).freeTranslationOrder.length !== patch.freeTranslationOrder.length; i++) await wait(100);
    if (live) {
      const article = await createPage(`http://127.0.0.1:${server.address().port}/live`);
      await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
      const primary = article.locator('#primary');
      report.counts = [];
      const started = Date.now();
      for (const expected of [1, 0, 1]) {
        await activateExtensionTabWithoutForeground(context, article, 30000);
        await primary.click(); await primary.hover();
        await article.keyboard.down('Control'); await article.keyboard.up('Control');
        await article.waitForFunction(expected => document.querySelector('#primary').querySelectorAll('.fluent-read-bilingual-content').length === expected, expected, {timeout: 30000});
        report.counts.push(await primary.locator('.fluent-read-bilingual-content').count());
        if (report.counts.length === 1) report.firstTranslationMs = Date.now() - started;
      }
      report.translation = await primary.locator('.fluent-read-bilingual-content').innerText();
      assert(/\p{Script=Han}/u.test(report.translation));
      assert.equal(await article.locator('#neighbor .fluent-read-bilingual-content').count(), 0);
      const imagePath = path.join(artifactsDir, 'live-translate-restore-retranslate.png');
      await article.screenshot({path: imagePath, animations: 'disabled'});
      report.screenshots.push(imagePath);
      report.ok = true;
      return;
    }
    await worker.evaluate(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.__freeFixture = {scenario: 'slow', calls: []};
      globalThis.fetch = (input, init = {}) => {
        const url = String(input);
        const route = url.includes('edge.microsoft.com/translate') ? 'microsoft' : url.includes('transmart.qq.com/api/imt') ? 'transmart' : null;
        if (!route) return originalFetch(input, init);
        const fixture = globalThis.__freeFixture;
        const event = {route, at: Date.now(), scenario: fixture.scenario, cancelled: false};
        fixture.calls.push(event);
        fixture.slowRoute ??= route;
        if (fixture.scenario === 'failure') return Promise.resolve(new Response('{}', {status: 503}));
        return new Promise((resolve, reject) => {
          let timer;
          const abort = () => { clearTimeout(timer); event.cancelled = true; reject(new DOMException('Fixture cancelled', 'AbortError')); };
          if (init.signal?.aborted) return abort();
          init.signal?.addEventListener('abort', abort, {once: true});
          if (route === fixture.slowRoute) return; // Hung primary with cooperative cancellation.
          timer = setTimeout(() => {
            init.signal?.removeEventListener('abort', abort);
            const translated = '当第一个服务较慢时，软件会使用快速备用服务翻译这个段落。';
            const body = route === 'microsoft' ? [{translations: [{text: translated}]}] : {header: {ret_code: 'succ'}, auto_translation: [translated]};
            resolve(new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}}));
          }, 100);
        });
      };
    });
    const article = await createPage(`http://127.0.0.1:${server.address().port}/`);
    await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const trigger = async selector => {
      await activateExtensionTabWithoutForeground(context, article, 30000);
      await article.locator(selector).click(); await article.locator(selector).hover();
      await article.keyboard.down('Control'); await article.keyboard.up('Control');
    };
    report.counts = [];
    const start = Date.now();
    for (const expected of [1, 0, 1]) {
      await trigger('#primary');
      await article.waitForFunction(expected => document.querySelectorAll('#primary .fluent-read-bilingual-content').length === expected, expected);
      if (report.counts.length === 0) report.firstTranslationMs = Date.now() - start;
      report.counts.push(await article.locator('#primary .fluent-read-bilingual-content').count());
      assert.equal(await article.locator('#neighbor .fluent-read-bilingual-content').count(), 0);
    }
    report.hedgeCalls = await worker.evaluate(() => globalThis.__freeFixture.calls);
    assert.equal(report.hedgeCalls.length, 2);
    assert.deepEqual(report.hedgeCalls.map(item => item.route).sort(), ['microsoft', 'transmart']);
    assert.equal(report.hedgeCalls[0].cancelled, true);

    const hedgeDelay = report.hedgeCalls[1].at - report.hedgeCalls[0].at;
    assert(hedgeDelay >= 1400 && hedgeDelay < 3000, `unexpected hedge delay ${hedgeDelay}`);
    assert(report.firstTranslationMs < 4500, 'slow primary delayed UI until timeout');
    const shot = async (page, name) => {const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);};
    await shot(article, 'translate-restore-retranslate');
    let settings = await createPage(`${extensionOrigin}/options.html`);
    await settings.locator('button[data-section="settings-services"]').click();
    await settings.getByRole('radio', {name: '智能加速', exact: true}).waitFor();
    assert.equal(await settings.locator('[data-free-translation-settings] details').count(), 0);
    assert.equal(await settings.locator('[data-fallback-provider]').count(), 13);
    assert.equal(await settings.locator('[data-provider-weight]').first().isVisible(), true);
    await settings.locator('[data-weight-total="100"]').waitFor();
    report.allServicesAndAllocationVisible = true;
    await shot(settings, 'settings-desktop');
    await settings.getByRole('radio', {name: '优先顺序', exact: true}).check();
    await settings.close();
    settings = await createPage(`${extensionOrigin}/options.html`);
    await settings.locator('button[data-section="settings-services"]').click();
    assert.equal(await settings.getByRole('radio', {name: '优先顺序', exact: true}).isChecked(), true);
    assert.deepEqual((await readConfig()).freeTranslationOrder, ['microsoft', 'transmart']);
    report.settingsQuickClosePersistence = true;
    await worker.evaluate(() => {globalThis.__freeFixture.slowRoute = 'microsoft';});
    const baselineStart = Date.now();
    await trigger('#baseline');
    await article.waitForFunction(() => document.querySelector('#baseline .fluent-read-bilingual-content'));
    report.sequentialTranslationMs = Date.now() - baselineStart;
    assert(report.sequentialTranslationMs >= 5000);
    assert(report.firstTranslationMs < report.sequentialTranslationMs - 2000);
    report.latencyReductionPercent = Math.round((1 - report.firstTranslationMs / report.sequentialTranslationMs) * 100);
    await settings.getByRole('radio', {name: '智能加速', exact: true}).check();
    await settings.setViewportSize({width: 390, height: 844});
    await shot(settings, 'settings-narrow');
    await settings.evaluate(() => document.documentElement.classList.add('dark'));
    await shot(settings, 'settings-narrow-dark');
    report.narrowOverflow = await settings.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(report.narrowOverflow, false);
    await worker.evaluate(() => {globalThis.__freeFixture.scenario = 'failure';});
    await trigger('#failure');
    await article.waitForFunction(() => document.querySelector('#failure .fluent-read-retry-wrapper'));
    const attempts = await worker.evaluate(() => globalThis.__freeFixture.calls.filter(item => item.scenario === 'failure'));
    assert.equal(attempts.length, 1);
    await wait(7500); // Old global retry delays total 1 + 2 + 4 seconds.
    report.failureCalls = await worker.evaluate(() => globalThis.__freeFixture.calls.filter(item => item.scenario === 'failure'));
    assert.equal(report.failureCalls.length, 1);
    report.noRepeatedPool = true;
    await shot(article, 'failed-service-no-retries');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close();
    await new Promise(resolve => server.close(resolve));
    console.log(JSON.stringify(report, null, 2));
  }
})();
