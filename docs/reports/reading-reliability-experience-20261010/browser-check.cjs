/** 验证本任务真实扩展的失败摘要/重试/恢复；仅临时后台 Edge 和固定页面，翻译由测试 worker 返回。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../../..');
const helper = require(path.join(root, 'scripts/testing/focus-safe-browser.cjs'));
const {guardBrowserClose} = require(path.join(root, 'scripts/testing/owned-browser-close.cjs'));
const {assertFreshProductionExtension} = require(path.join(root, 'scripts/run-site-translation-test.cjs'));
const playwrightRoot = process.env.FLUENTREAD_PLAYWRIGHT_ROOT || '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {chromium} = createRequire(path.join(playwrightRoot, '__fluentread_reliability__.cjs'))('playwright');
const build = path.join(root, '.output/chrome-mv3');
const output = path.join(root, 'reports/reading-reliability-experience-20261010/browser');
const report = {scope: 'Controlled real extension: failure summary, locate, failed-only retry, retained DOM and restore/retranslate', errors: []};
fs.mkdirSync(output, {recursive: true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-reliability-'));
let session;
(async () => {
  try {
    assertFreshProductionExtension(build);
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir: profile,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false,
      background: true, displayTarget: 'secondary', viewport: {width: 1100, height: 800},
      browserArgs: [`--disable-extensions-except=${build}`, `--load-extension=${build}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profile);
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(session.launchMode, 'macos-background-cdp');
    assert.equal(session.windowPlacement.browserFrontmost, false);
    const context = session.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.reliabilityRequests = []; globalThis.reliabilityFail = true;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') throw new Error('External test fetch blocked');
        const texts = JSON.parse(init?.body || await input.text());
        globalThis.reliabilityRequests.push(texts);
        if (globalThis.reliabilityFail && texts.some(text => text.includes('Failed paragraph'))) {
          return new Response('Invalid request', {status: 400});
        }
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text: `测试译文：${text}`}]}))),
          {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    const fixtureUrl = 'https://example.com/fluentread-reliability-fixture';
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === fixtureUrl) return route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Recovery fixture</title></head><body style="font:20px sans-serif;padding:40px"><p id="good">Successful paragraph keeps its translation and reader position.</p><p id="bad">Failed paragraph should retry without touching successful content.</p><button id="host">Save changes</button></body></html>'});
      if (/^https?:/u.test(url)) return route.abort('blockedbyclient');
      return route.continue();
    });
    const popup = await helper.newPageWithoutForeground(context);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.waitForTimeout(600);
    const fontPath = '/pdf-fonts/FluentReadNotoSansSC-Regular.woff2';
    report.bundledFont = await popup.evaluate(async fontPath => {
      const response = await fetch(fontPath);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {ok: response.ok, bytes: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')};
    }, fontPath);
    const fontBytes = fs.readFileSync(path.join(root, 'public', fontPath));
    assert.equal(report.bundledFont.ok, true);
    assert.equal(report.bundledFont.bytes, fontBytes.byteLength);
    assert.equal(report.bundledFont.sha256, require('node:crypto').createHash('sha256').update(fontBytes).digest('hex'));
    const patch = {on: true, service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1,
      hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'all',
      useCache: false, enableAIContext: false, enableAIMultiSegment: false, animations: false,
      pageTitleTranslationEnabled: false, translationProgressPanelEnabled: true,
      autoTranslate: false, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true};
    const saved = await popup.evaluate(async patch => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch,
        expected: Object.fromEntries(Object.keys(patch).map(key => [key, config[key]])),
        clientId: 'reliability-browser-test', sequence: 1, baseRevision: config.__fluentConfigRevision});
    }, patch);
    assert.equal(saved.success, true, JSON.stringify(saved));
    const page = await helper.newPageWithoutForeground(context);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(fixtureUrl);
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    const toggle = async () => {
      await helper.activateExtensionTabWithoutForeground(context, page);
      await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
    };
    await toggle();
    const panel = page.locator('.fr-translation-progress');
    await panel.locator('button', {hasText: '重试失败项'}).waitFor();
    await page.waitForFunction(() => {
      const host = document.querySelector('fluent-read-translation-progress-ui');
      const panel = host?.shadowRoot?.querySelector('.fr-translation-progress');
      return panel?.getAttribute('data-failed') === '1' && panel.getAttribute('data-running') === '0';
    });
    report.failed = await panel.evaluate(node => ({failed: node.dataset.failed, completed: node.dataset.completed, text: node.textContent}));
    await page.evaluate(() => {window.savedTranslation = document.querySelector('#good .fluent-read-bilingual-content');});
    await page.screenshot({path: path.join(output, 'failure-summary.png'), caret: 'initial'});
    await panel.locator('button', {hasText: '定位失败段落'}).click();
    await worker.evaluate(() => {globalThis.reliabilityFail = false;});
    const before = await worker.evaluate(() => globalThis.reliabilityRequests.length);
    await panel.locator('button', {hasText: '重试失败项'}).click();
    await page.waitForSelector('#bad .fluent-read-bilingual-content');
    assert.equal(await page.evaluate(() => window.savedTranslation === document.querySelector('#good .fluent-read-bilingual-content')), true);
    report.retryRequests = await worker.evaluate(before => globalThis.reliabilityRequests.slice(before), before);
    assert.equal(report.retryRequests.length, 1);
    assert.ok(report.retryRequests[0].every(text => text.includes('Failed paragraph')));
    await toggle();
    await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper'));
    await toggle();
    await page.waitForSelector('#good .fluent-read-bilingual-content');
    await page.waitForSelector('#bad .fluent-read-bilingual-content');
    await page.screenshot({path: path.join(output, 'restored-and-translated.png'), caret: 'initial'});
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {report.passed = false; report.failure = error.stack || String(error); process.exitCode = 1;}
  finally {
    if (session) {try {await session.close(); fs.rmSync(profile, {recursive: true, force: true});} catch(error) {report.cleanupError = String(error); process.exitCode = 1;}}
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
