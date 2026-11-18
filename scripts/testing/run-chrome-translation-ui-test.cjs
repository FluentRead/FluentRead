'use strict';
const {guardBrowserClose} = require('./owned-browser-close.cjs');
/**
 * @file scripts/testing/run-chrome-translation-ui-test.cjs
 * 文件职责：用隔离的 Chrome 或 Edge 验证内置翻译准备、模型状态和后续离屏翻译。
 * 主要内容：通过 CDP 加载生产扩展，分别记录原生 API 结果与可控 API 边界回归，检查自动语言、激活、失败帮助和响应式。
 * 模块边界：只操作新建临时 profile；模型 mock 仅用于明确标记的 UI 合约，不作为原生翻译成功证据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-chrome-translation-ui'));
const browserName = arg('browser', 'chrome');
assert.ok(['chrome', 'edge'].includes(browserName), 'Choose --browser chrome or edge');
const edge = browserName === 'edge';
const expectsUnavailable = arg('expect-unavailable', 'false') === 'true';
const helpUrl = edge ? 'https://learn.microsoft.com/microsoft-edge/web-platform/translator-api'
  : 'https://developer.chrome.com/docs/ai/translator-api';
const diagnosticsHelper = arg('runtime-diagnostics-helper', '');
const diagnostics = diagnosticsHelper ? require(path.resolve(diagnosticsHelper)).createRuntimeDiagnostics() : null;
const {chromium} = require(path.join(arg('playwright-root', ''), 'playwright'));
const {
  activateExtensionTabWithoutForeground, launchFocusSafePersistentContext, newPageWithoutForeground,
} = require(path.resolve(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs'))));
const storagePrefix = 'fluentread.chromeTranslationPreparation.';
const pendingKey = (source, target) => `${storagePrefix}${source}:${target}`;
const skipNative = arg('skip-native', 'false') === 'true';
assert.ok(!skipNative || arg('require-native', 'false') !== 'true', 'Native verification cannot be required and skipped together');
fs.mkdirSync(artifactsDir, {recursive: true});
const report = {extensionDir, browserName, scope: expectsUnavailable ? 'unsupported-browser' : skipNative ? 'ui-contract' : 'native-and-ui-contract', cases: [], native: {}, screenshots: [], consoleErrors: []};

async function main() {
  const suppliedProfile = arg('profile-dir', '');
  const profileDir = suppliedProfile ? path.resolve(suppliedProfile) : fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-chrome-ui-'));
  assert.ok((profileDir.startsWith('/private/tmp/') || profileDir.startsWith(os.tmpdir())) && path.basename(profileDir).startsWith('fluentread-chrome-ui-'), 'Only dedicated temporary test profiles are permitted');
  report.profileMode = suppliedProfile ? 'reused-task-model-cache' : 'fresh';
  let launched, cdp;
  let primaryError;
  let launchAttempted = false;
  try {
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({
      chromium, profileDir,
      browserPath: arg('browser-path', edge ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      headless: false, background: true,
      browserArgs: ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging',
        ...(expectsUnavailable ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : [])],
      viewport: {width: 1440, height: 1000}, timeout: 30000,
    });
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const {context} = launched;
    report.browserVersion = context.browser().version();
    await diagnostics?.start(context);
    cdp = await context.browser().newBrowserCDPSession();
    const id = expectsUnavailable
      ? new URL((context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js'))
          || await context.waitForEvent('serviceworker', {predicate: worker => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js'), timeout: 30000})).url()).hostname
      : (await cdp.send('Extensions.loadUnpacked', {path: extensionDir})).id;
    diagnostics?.setExtensionId(id);
    const page = await newPageWithoutForeground(context);
    await diagnostics?.attachPage(page, 'service-options');
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') report.consoleErrors.push(entry.text()); });
    await page.goto(`chrome-extension://${id}/options.html#settings-services`);
    await page.locator('.service-catalog').waitFor();
    await page.evaluate(async () => {
      const {value} = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const saved = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: {from: 'auto', to: 'zh-Hans', uiLanguage: 'zh-CN'}, expected: {from: value.from, to: value.to, uiLanguage: value.uiLanguage}, clientId: 'chrome-ui-test', sequence: 1});
      if (!saved?.success) throw new Error(saved?.error || 'Unable to configure isolated fixture');
    });
    await page.reload();
    await page.locator('[data-service-value="chromeTranslator"]').click();
    const button = page.locator('[data-connection-test-button]');
    const status = page.locator('[data-connection-test-status]');
    assert.equal((await page.locator('.detail-heading h4').textContent()).trim(), '浏览器内置翻译');
    assert.equal(await page.getByTestId('service-website-link').getAttribute('href'), helpUrl);
    if (expectsUnavailable) {
      assert.match(await page.locator('[data-browser-translation-unavailable]').textContent(), edge ? /Edge 148/ : /Chrome 138/);
      assert.equal(await button.count(), 0);
      assert.equal(await page.locator('[data-set-default-service-button]').isDisabled(), true);
      await page.screenshot({path: path.join(artifactsDir, 'browser-translation-unavailable.png')});
      report.screenshots.push('browser-translation-unavailable.png');
      report.cases.push('unavailable-with-browser-specific-guidance');
      report.ok = true;
      return;
    }
    assert.equal(await page.locator('[data-chrome-preparation-source]').count(), 0);
    assert.match((await button.textContent()).trim(), /^(准备|检查)语言包$/u);
    assert.equal(await status.count(), 1);
    assert.equal(await page.locator('[data-chrome-preparation-help]').count(), 0);
    assert.doesNotMatch(await status.textContent(), /（en）|（zh）|本次检查|官方帮助与诊断/u);
    report.cases.push('single-status-and-header-help');

    if (skipNative) {
      report.native.skipped = true;
    } else {
      report.native.availability = await page.evaluate(async () => ({
        translator: typeof Translator === 'undefined' ? 'missing' : await Translator.availability({sourceLanguage: 'en', targetLanguage: 'zh'}),
        detector: typeof LanguageDetector === 'undefined' ? 'missing' : await LanguageDetector.availability(),
      }));
      if (Object.values(report.native.availability).includes('downloadable')) {
        diagnostics?.setPhase('unprepared-native-model');
        report.native.beforePreparation = await page.evaluate(() => chrome.runtime.sendMessage({
          type: 'testTranslationService', service: 'chromeTranslator', requestId: 'unprepared-language-pack',
        }));
        assert.equal(report.native.beforePreparation?.diagnostic?.code, 'browser-translation-preparation-required');
      }
      await page.evaluate(() => {
        globalThis.__chromeNativeProbe = [];
        for (const name of ['Translator', 'LanguageDetector']) {
          const api = globalThis[name];
          const create = api.create.bind(api);
          api.create = options => {
            const event = {api: name, phase: 'creating', activated: navigator.userActivation.isActive};
            globalThis.__chromeNativeProbe.push(event);
            return create(options).then(result => { event.phase = 'created'; return result; }, error => { event.phase = 'failed'; event.error = `${error.name}: ${error.message}`; throw error; });
          };
        }
      });
      diagnostics?.setPhase('native-language-pack');
      await button.click();
      try {
        await page.locator('[data-connection-test-status]:is(.is-success, .is-error)').waitFor({timeout: 310000});
      } finally {
        report.native.operations = await page.evaluate(() => globalThis.__chromeNativeProbe);
      }
      report.native.preparation = await status.textContent();
      report.native.preparationSucceeded = await status.evaluate(element => element.classList.contains('is-success'));
      if (report.native.preparationSucceeded) {
        diagnostics?.setPhase('native-offscreen-translation');
        report.native.offscreen = await page.evaluate(async () => {
          const requestId = 'native-chrome-ui-offscreen';
          // Trigger the provider's existing background connection check, which creates the production Offscreen document.
          return await chrome.runtime.sendMessage({type: 'testTranslationService', service: 'chromeTranslator', requestId});
        });
      }
      await page.screenshot({path: path.join(artifactsDir, 'chrome-native-preparation.png')});
      report.screenshots.push('chrome-native-preparation.png');
      if (report.native.offscreen?.success) {
        diagnostics?.setPhase('native-webpage-translation');
        await page.locator('[data-set-default-service-button]').click();
        await page.locator('.service-catalog[data-default-service="chromeTranslator"]').waitFor();
        const samplePage = await newPageWithoutForeground(context);
        await diagnostics?.attachPage(samplePage, 'native-webpage');
        const url = 'https://fluentread-fixture.test/browser-translation';
        const source = 'This little library opens its doors every morning so that children can read books and learn about the world.';
        await samplePage.route(url, route => route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><title>Translation test</title><main><p>${source}</p></main></html>`,
        }));
        await samplePage.goto(url);
        await samplePage.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
        await page.evaluate(async fixtureUrl => {
          const [fixture] = await chrome.tabs.query({url: fixtureUrl});
          if (!fixture?.id) throw new Error('The fixture is missing from the extension’s tabs');
          await chrome.tabs.update(fixture.id, {active: true});
        }, url);
        const paragraph = samplePage.locator('main p');
        const translated = paragraph.locator('.fluent-read-bilingual-content');
        report.native.webpage = {counts: []};
        for (const count of [1, 0, 1]) {
          await paragraph.hover();
          await paragraph.click();
          await samplePage.keyboard.down('Control');
          await samplePage.keyboard.up('Control');
          await translated.waitFor({state: count ? 'attached' : 'detached', timeout: 20000});
          assert.equal(await translated.count(), count);
          report.native.webpage.counts.push(count);
        }
        report.native.webpage.translation = await translated.textContent();
        assert.match(report.native.webpage.translation, /\p{Script=Han}/u);
        await samplePage.screenshot({path: path.join(artifactsDir, 'native-webpage-translation.png')});
        report.screenshots.push('native-webpage-translation.png');
        await samplePage.close();
        await activateExtensionTabWithoutForeground(context, page, 10000);
        report.cases.push('native-webpage-translate-restore-repeat');
      }
    }

    // These cases replace only the browser API boundary. They do not claim native model success.
    diagnostics?.setPhase('mock-boundary');
    await page.evaluate(() => {
      globalThis.__chromeUiProbe = {source: 'fr', calls: [], fail: false, holdCreate: true, destroyed: 0};
      globalThis.LanguageDetector = {create: async () => ({detect: async () => [{detectedLanguage: globalThis.__chromeUiProbe.source, confidence: 0.99}], destroy: () => globalThis.__chromeUiProbe.destroyed++})};
      globalThis.Translator = {availability: async () => 'downloadable', create: async options => {
        globalThis.__chromeUiProbe.calls.push({sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage, activated: navigator.userActivation.isActive});
        if (globalThis.__chromeUiProbe.fail) throw new DOMException('The language model component is not available.', 'NotSupportedError');
        if (globalThis.__chromeUiProbe.holdCreate) {
          options.monitor?.({addEventListener: (event, listener) => {
            if (event === 'downloadprogress') globalThis.__chromeUiProbe.downloadProgress = listener;
          }});
          await new Promise(resolve => { globalThis.__chromeUiProbe.releaseCreate = resolve; });
        }
        return {translate: async () => { if (globalThis.__chromeUiProbe.hold) await new Promise(resolve => { globalThis.__chromeUiProbe.release = resolve; }); return '这是一句浏览器边界测试译文。'; }, destroy: () => globalThis.__chromeUiProbe.destroyed++};
      }};
    });
    await page.evaluate(async key => { await chrome.storage.session.set({[key]: {sourceLanguage: 'fr', targetLanguage: 'zh', updatedAt: Date.now()}}); }, pendingKey('fr', 'zh'));
    const languagePair = page.locator('[data-chrome-preparation-language-pair]');
    await languagePair.filter({hasText: /法语/u}).waitFor();
    await status.getByText('待准备', {exact: true}).waitFor();
    assert.match(await status.textContent(), /首次下载需联网/u);
    await page.screenshot({path: path.join(artifactsDir, 'language-pack-needed.png')});
    report.screenshots.push('language-pack-needed.png');
    await button.click();
    await page.waitForFunction(() => typeof globalThis.__chromeUiProbe.releaseCreate === 'function');
    await page.evaluate(() => globalThis.__chromeUiProbe.downloadProgress({loaded: .42}));
    await status.getByText('下载中 42%', {exact: true}).waitFor();
    assert.equal(await status.locator('progress').getAttribute('value'), '42');
    await page.screenshot({path: path.join(artifactsDir, 'language-pack-downloading.png')});
    report.screenshots.push('language-pack-downloading.png');
    await page.evaluate(() => {
      globalThis.__chromeUiProbe.holdCreate = false;
      globalThis.__chromeUiProbe.releaseCreate();
    });
    await page.waitForFunction(() => document.querySelector('[data-connection-test-status]')?.classList.contains('is-success'));
    const first = await page.evaluate(() => globalThis.__chromeUiProbe.calls.at(-1));
    assert.deepEqual(first, {sourceLanguage: 'fr', targetLanguage: 'zh', activated: true});
    assert.equal(await page.evaluate(async key => (await chrome.storage.session.get(key))[key] || null, pendingKey('fr', 'zh')), null);
    assert.match(await languagePair.textContent(), /^法语 → /u);
    assert.equal(await status.locator('.chrome-preparation-badge').textContent(), '已就绪');
    assert.equal(await status.locator('.chrome-preparation-hint, progress, details').count(), 0);
    assert.equal((await button.textContent()).trim(), '检查语言包');
    await page.screenshot({path: path.join(artifactsDir, 'language-pack-ready.png')});
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: path.join(artifactsDir, 'language-pack-ready-narrow.png')});
    await page.setViewportSize({width: 1440, height: 1000});
    report.screenshots.push('language-pack-ready.png', 'language-pack-ready-narrow.png');
    report.cases.push('compact-waiting-downloading-and-ready');
    report.cases.push('pending-source-consumed-with-real-user-activation');

    await page.evaluate(async key => { await chrome.storage.session.set({[key]: {sourceLanguage: 'ja', targetLanguage: 'fr', updatedAt: Date.now()}}); }, pendingKey('ja', 'fr'));
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-connection-test-status]')?.classList.contains('is-success'));
    assert.match(await languagePair.textContent(), /^法语 → /u);
    assert.equal(await page.evaluate(() => globalThis.__chromeUiProbe.calls.length), 2);
    assert.deepEqual(await page.evaluate(() => globalThis.__chromeUiProbe.calls.at(-1)), {sourceLanguage: 'fr', targetLanguage: 'zh', activated: true});
    assert.deepEqual(await page.evaluate(async key => { const {sourceLanguage, targetLanguage} = (await chrome.storage.session.get(key))[key]; return {sourceLanguage, targetLanguage}; }, pendingKey('ja', 'fr')), {sourceLanguage: 'ja', targetLanguage: 'fr'});
    report.cases.push('other-target-pending-not-reused-or-cleared');

    // A second extension document writes a new pair while this settings page is preparing the previous pair.
    const otherPage = await newPageWithoutForeground(context);
    await otherPage.goto(`chrome-extension://${id}/options.html#settings-services`);
    await page.evaluate(async key => {
      globalThis.__chromeUiProbe.source = 'fr';
      globalThis.__chromeUiProbe.hold = true;
      await chrome.storage.session.set({[key]: {sourceLanguage: 'fr', targetLanguage: 'zh', updatedAt: Date.now()}});
    }, pendingKey('fr', 'zh'));
    await languagePair.filter({hasText: /法语/u}).waitFor();
    await button.click();
    await page.waitForFunction(() => typeof globalThis.__chromeUiProbe.release === 'function');
    await otherPage.evaluate(async key => {
      await chrome.storage.session.set({[key]: {sourceLanguage: 'ja', targetLanguage: 'zh', updatedAt: Date.now()}});
    }, pendingKey('ja', 'zh'));
    await page.evaluate(() => { globalThis.__chromeUiProbe.hold = false; globalThis.__chromeUiProbe.release(); });
    await languagePair.filter({hasText: /日语/u}).waitFor();
    await status.getByText('待准备', {exact: true}).waitFor();
    assert.equal(await page.evaluate(async key => (await chrome.storage.session.get(key))[key] || null, pendingKey('fr', 'zh')), null);
    assert.equal(await otherPage.evaluate(async key => (await chrome.storage.session.get(key))[key]?.sourceLanguage, pendingKey('ja', 'zh')), 'ja');
    await page.evaluate(() => { globalThis.__chromeUiProbe.source = 'ja'; });
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-connection-test-status]')?.classList.contains('is-success'));
    assert.deepEqual(await page.evaluate(() => globalThis.__chromeUiProbe.calls.at(-1)), {sourceLanguage: 'ja', targetLanguage: 'zh', activated: true});
    await otherPage.close();
    report.cases.push('other-context-pending-survives-successful-preparation');

    await page.evaluate(() => { globalThis.__chromeUiProbe.fail = true; });
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-connection-test-status]')?.classList.contains('is-error'));
    assert.equal(await status.locator('.chrome-preparation-badge').textContent(), '准备失败');
    assert.equal(await status.locator('.chrome-preparation-hint').textContent(), '请检查网络和浏览器的语言支持。');
    assert.doesNotMatch(await status.textContent(), /language model component/);
    report.cases.push('model-error-shows-actionable-sanitized-help');
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({width, height: 1000});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `Horizontal overflow at ${width}`);
      const buttonFits = await button.evaluate(element => {
        const buttonBounds = element.getBoundingClientRect();
        const panelBounds = element.closest('.service-detail').getBoundingClientRect();
        return buttonBounds.left >= panelBounds.left && buttonBounds.right <= panelBounds.right
          && element.scrollWidth <= element.clientWidth;
      });
      assert.equal(buttonFits, true, `Preparation button is clipped at ${width}`);
      const file = `chrome-preparation-${width}.png`;
      await page.screenshot({path: path.join(artifactsDir, file)});
      report.screenshots.push(file);
    }
    report.cases.push('responsive-1440-820-390');
    report.mockBoundary = await page.evaluate(() => globalThis.__chromeUiProbe);
    assert.equal(report.consoleErrors.length, 0, 'The settings page emitted console or page errors');
    report.uiContractPassed = true;
    report.nativePassed = report.native.preparationSucceeded === true && report.native.offscreen?.success === true
      && report.native.webpage?.counts.join(',') === '1,0,1';
    report.ok = report.uiContractPassed && (skipNative || report.nativePassed);
    if (arg('require-native', 'false') === 'true') assert.equal(report.nativePassed, true, 'Native model preparation or offscreen translation failed');
  } catch (error) {
    primaryError = error;
    report.ok = false;
    report.error = error.stack || String(error);
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    if (diagnostics) {
      await cleanup(async () => {
        await diagnostics.flush();
        await diagnostics.write(artifactsDir, report);
        if (!primaryError) diagnostics.assertClean();
      });
      await cleanup(() => diagnostics.stop());
    }
    await cleanup(async () => {await cdp?.detach();});
    await cleanup(async () => {
      if (launched) {await launched.close(); browserClosed = true;}
    });
    await cleanup(() => {
      if (suppliedProfile) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    if (cleanupErrors.length) {
      report.ok = false;
      report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
    }
    await cleanup(() => {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
