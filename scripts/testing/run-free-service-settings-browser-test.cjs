#!/usr/bin/env node
'use strict';
const {waitForAsyncCondition} = require('./wait-for-async-condition.cjs');
// 免费服务设置专项：统一目录、测试耗时/失败/重测、分流、邮箱、顺序与多尺寸；仅使用隔离后台 Chromium profile。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const live = process.argv.includes('--live');
const loadViaCdp = process.argv.includes('--load-via-cdp');
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-free-service-settings'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper'));
const ids = ['microsoft', 'bilibiliFree', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'myMemory', 'sogouFree', 'reversoFree', 'apertiumFree', 'alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree'];
const defaultIds = ids;
const report = {ok: false, extensionDir, evidenceBoundary: process.argv.includes('--bilibili-live') ? 'Production extension Bilibili-only real connection check on a synthetic sentence; verifies installed DNR and provider transport, not all-site translation quality.' : live ? 'Real anonymous connection tests on a fixed synthetic sentence; one network and one run.' : 'Production extension UI with controlled connection-message results; provider behavior is tested separately.', caseCoverage: [], screenshots: [], consoleErrors: [], layouts: []};
fs.mkdirSync(artifactsDir, {recursive: true});
(async () => {
  let launched, profileDir;
  let launchAttempted = false;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-free-settings-'));
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000, browserArgs: [...(loadViaCdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]), '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    let origin;
    if (loadViaCdp) {
      const session = await context.browser().newBrowserCDPSession();
      try {const {id} = await session.send('Extensions.loadUnpacked', {path: extensionDir}); origin = `chrome-extension://${id}`; report.extensionLoad = {method: 'Extensions.loadUnpacked', id};}
      finally {await session.detach();}
    } else {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
      origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    }
    const create = async url => {const p = await newPageWithoutForeground(context, 30000); p.on('pageerror', e => report.consoleErrors.push(e.message)); await p.goto(url, {waitUntil: 'domcontentloaded'}); return p;};
    const popup = await create(`${origin}/popup.html`);
    const readConfig = () => popup.evaluate(async () => {const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;});
    await waitForAsyncCondition(() => popup.evaluate(async () => {const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); return typeof r.value === 'string' ? JSON.parse(r.value)?.service : r.value?.service;}), {timeoutMs: 30000, message: "免费服务测试默认服务配置尚未就绪"});
    const existing = await readConfig();
    assert.deepEqual(existing.freeTranslationOrder, defaultIds);
    report.caseCoverage.push('fresh configuration enables 16 official providers');
    const patch = {uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, service: 'freeTranslation', from: 'en', to: 'zh-Hans', freeTranslationMode: 'balanced', freeTranslationOrder: defaultIds, freeTranslationTimeoutMs: 5000};
    assert.equal((await popup.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected, clientId: `free-settings-${crypto.randomUUID()}`, sequence: 1}), {patch, expected: Object.fromEntries(Object.keys(patch).map(k => [k, existing[k]]))})).success, true);
    let page = await create(`${origin}/options.html`);
    await page.locator('button[data-section="settings-services"]').click();
    const basic = () => page.locator('[data-free-translation-settings]:not(.is-advanced)');
    await basic().locator('[data-fallback-provider]').last().waitFor();
    assert.equal(await basic().locator('[data-fallback-provider]').count(), 16);
    assert.equal(await basic().locator('details').count(), 0);
    assert.equal(await basic().locator('[data-provider-state]').count(), 16);
    assert.equal(await basic().locator('[data-provider-weight]').count(), 16);
    assert.equal(await basic().locator('input[type="email"]').isVisible(), true);
    assert.equal(await basic().locator('[data-fallback-provider="deeplx"]').count(), 0);
    assert.equal(await basic().locator('[data-fallback-provider="lingvaFree"]').count(), 0);
    assert.deepEqual(await basic().locator('[data-fallback-provider]').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.fallbackProvider)), ['microsoft', 'bilibiliFree']);
    assert.equal(await basic().locator('[data-provider-recommended="bilibiliFree"]').textContent(), '推荐');
    report.caseCoverage.push('16 official services, states and allocation visible without expansion; email outside cards');
    if (process.argv.includes('--bilibili-live')) {
      const rules = await popup.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      const rule = rules.find(rule => rule.condition.regexFilter?.includes('index-translate'));
      assert.ok(rule, 'Bilibili Origin rule missing');
      assert.deepEqual(rule.condition.initiatorDomains, [origin.replace('chrome-extension://', '')]);
      assert.deepEqual(rule.action.requestHeaders, [{header: 'Origin', operation: 'remove'}]);
      const result = await popup.evaluate(() => chrome.runtime.sendMessage({type: 'testTranslationService', service: 'freeTranslation', freeProviderId: 'bilibiliFree'}));
      const standalone = await popup.evaluate(() => chrome.runtime.sendMessage({type: 'testTranslationService', service: 'bilibili'}));
      report.bilibiliLive = {result, standalone, rule};
      assert.equal(standalone.success, true, JSON.stringify(standalone));
      assert.equal(result.success, true, JSON.stringify(result));
      const screenshot = path.join(artifactsDir, 'bilibili-free-settings.png');
      await basic().locator('[data-fallback-provider="bilibiliFree"]').scrollIntoViewIfNeeded();
      await page.screenshot({path: screenshot, animations: 'disabled'}); report.screenshots.push(screenshot);
      await page.locator('[data-service-value="bilibili"]').click();
      await page.locator('[data-service-no-setup]').waitFor();
      assert.equal(await page.locator('[data-editing-service]').getAttribute('data-editing-service'), 'bilibili');
      assert.equal((await readConfig()).service, 'freeTranslation');
      assert.equal(await page.locator('[data-service-nature-badge="bilibili"]').first().textContent(), '推荐');
      const standaloneShot = path.join(artifactsDir, 'bilibili-standalone-desktop.png');
      await page.screenshot({path: standaloneShot, animations: 'disabled'}); report.screenshots.push(standaloneShot);
      await page.setViewportSize({width: 390, height: 960});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const mobileShot = path.join(artifactsDir, 'bilibili-standalone-mobile.png');
      await page.screenshot({path: mobileShot, animations: 'disabled'}); report.screenshots.push(mobileShot);
      report.caseCoverage.push('Microsoft first, Bilibili second with recommendation; standalone machine service, no setup, separate editing/default state, 390px no overflow; both live transports');
      assert.deepEqual(report.consoleErrors, []); report.ok = true; return;
    }
    if (!live) await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__freeChecks = {calls: [], active: 0, peak: 0, delay: 70};
      chrome.runtime.sendMessage = function(message, ...args) {
        if (message?.type !== 'testTranslationService') return original(message, ...args);
        const fixture = window.__freeChecks;
        fixture.calls.push(message.freeProviderId); fixture.active++; fixture.peak = Math.max(fixture.peak, fixture.active);
        const id = message.freeProviderId;
        const error = {yandexFree: 'Yandex 网络连接失败，请检查网络后重试或停用此服务', sogouFree: '搜狗翻译未返回译文（错误码 s10）；请稍后重试或停用此服务', lingvanexFree: 'Lingvanex 官网拒绝自动访问，请稍后重试或停用此服务: 403'}[id];
        const promise = new Promise(resolve => setTimeout(() => {fixture.active--; resolve(error ? {success: false, error} : {success: true, durationMs: id === 'microsoft' ? 35 : 1200});}, fixture.delay));
        const callback = args.find(a => typeof a === 'function');
        if (callback) {promise.then(callback); return;}
        return promise;
      };
    });
    const before = (await readConfig()).freeTranslationOrder;
    await page.locator('[data-connection-test-button]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-provider-duration]').length === 16, undefined, {timeout: 45000});
    report.results = await basic().locator('[data-fallback-provider]').evaluateAll(nodes => nodes.map(node => ({id: node.dataset.fallbackProvider, status: node.querySelector('[data-provider-state]').dataset.providerCheckStatus, duration: node.querySelector('[data-provider-duration]')?.textContent, error: document.querySelector(`[data-provider-error="${node.dataset.fallbackProvider}"]`)?.textContent})));
    assert.deepEqual((await readConfig()).freeTranslationOrder, before);
    assert.equal(report.results.every(r => /^\d+ ms$/u.test(r.duration)), true);
    if (!live) {
      assert.equal(report.results.filter(r => r.status === 'error').length, 3);
      const fixture = await page.evaluate(() => ({calls: window.__freeChecks.calls, peak: window.__freeChecks.peak}));
      assert.deepEqual(fixture.calls, ids); assert.equal(fixture.peak, 3);
      assert.equal(report.results.find(r => r.id === 'microsoft').duration, '35 ms');
      assert.equal(await basic().locator('[data-provider-error="sogouFree"]').isVisible(), true);
      const lingvaSwitch = basic().locator('[data-fallback-provider="lingvanexFree"] .el-switch');
      await lingvaSwitch.click();
      assert.equal(await basic().locator('[data-provider-state="lingvanexFree"]').getAttribute('data-provider-check-status'), 'error');
      assert.equal(await basic().locator('[data-provider-duration="lingvanexFree"]').isVisible(), true);
      await lingvaSwitch.click();
    }
    report.caseCoverage.push('success and failure duration; disabled-provider results; all-provider checks keep enabled list');
    const shot = async name => {const p = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: p, animations: 'disabled'}); report.screenshots.push(p);};
    await basic().locator('.section-heading').scrollIntoViewIfNeeded();
    await shot(live ? 'live-checks-desktop' : 'checks-desktop');
    if (live) {report.ok = true; return;}
    await page.evaluate(() => {window.__freeChecks.delay = 400;});
    await page.locator('[data-connection-test-button]').click();
    assert.equal(await basic().locator('[data-provider-duration]').count(), 0);
    await page.waitForFunction(() => document.querySelectorAll('[data-provider-duration]').length === 16);
    report.caseCoverage.push('retest immediately clears old durations');
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({width, height: 960});
      const layout = await basic().evaluate(node => ({width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, cardOverflow: [...node.querySelectorAll('[data-fallback-provider]')].some(card => card.scrollWidth > card.clientWidth), cardHeights: [...node.querySelectorAll('[data-fallback-provider]')].map(card => Math.round(card.getBoundingClientRect().height))}));
      assert.equal(layout.overflow, false); assert.equal(layout.cardOverflow, false); assert.equal(new Set(layout.cardHeights).size, 1); report.layouts.push(layout);
      await shot(`checks-${width}`);
    }
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await shot('checks-390-dark');
    await basic().locator('[data-provider-error="lingvanexFree"]').scrollIntoViewIfNeeded();
    await shot('checks-390-dark-failures');
    await page.setViewportSize({width: 1440, height: 960});
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.getByRole('radio', {name: '优先顺序', exact: true}).check();
    await basic().getByRole('button', {name: '下移 微软翻译', exact: true}).click();
    await page.close();
    page = await create(`${origin}/options.html`);
    await page.locator('button[data-section="settings-services"]').click();
    assert.equal(await page.getByRole('radio', {name: '优先顺序', exact: true}).isChecked(), true);
    assert.equal((await readConfig()).freeTranslationOrder[0], 'transmart');
    const email = basic().locator('input[type="email"]');
    await email.fill('contact@'); await email.blur();
    assert.equal((await readConfig()).myMemoryEmail, '');
    await email.fill('first@example.test'); await email.blur();
    await email.fill('contact@example.test'); await email.blur();
    await page.close();
    page = await create(`${origin}/options.html`);
    await page.locator('button[data-section="settings-services"]').click();
    await basic().locator('input[type="email"]').waitFor();
    assert.equal(await basic().locator('input[type="email"]').inputValue(), 'contact@example.test');
    report.quickClose = true; report.latestWriteWins = true; report.crossPageSync = (await readConfig()).myMemoryEmail === 'contact@example.test';
    report.persistenceCases = [{setting: 'priority order', reopened: (await readConfig()).freeTranslationOrder}, {setting: 'MyMemory email', writes: ['first@example.test', 'contact@example.test'], reopened: await basic().locator('input[type="email"]').inputValue()}];
    report.caseCoverage.push('priority reorder and valid email persist after immediate close; partial email stays local');
    await basic().locator('input[type="email"]').scrollIntoViewIfNeeded();
    await shot('reopened-settings');
    const latest = await readConfig();
    assert.equal((await popup.evaluate(expected => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: {uiLanguage: 'en-US', freeTranslationMode: 'balanced'}, expected, clientId: `free-settings-${crypto.randomUUID()}`, sequence: 1}), {uiLanguage: latest.uiLanguage, freeTranslationMode: latest.freeTranslationMode})).success, true);
    await page.reload();
    await page.locator('button[data-section="settings-services"]').click();
    await basic().locator('[data-fallback-provider]').last().waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 960});
      const layout = await basic().evaluate(node => ({width: innerWidth, language: 'en-US', overflow: document.documentElement.scrollWidth > innerWidth, cardOverflow: [...node.querySelectorAll('[data-fallback-provider]')].some(card => card.scrollWidth > card.clientWidth), cardHeights: [...node.querySelectorAll('[data-fallback-provider]')].map(card => Math.round(card.getBoundingClientRect().height))}));
      assert.equal(layout.overflow, false); assert.equal(layout.cardOverflow, false); assert.equal(new Set(layout.cardHeights).size, 1); report.layouts.push(layout);
      await shot(`english-${width}`);
    }
    for (const [language, label] of [['zh-CN', '免费 · 非官方'], ['en-US', 'Free · Unofficial']]) {
      const config = await readConfig();
      assert.equal((await popup.evaluate(expected => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: {uiLanguage: expected.next}, expected: {uiLanguage: expected.current}, clientId: `free-settings-${crypto.randomUUID()}`, sequence: 1}), {current: config.uiLanguage, next: language})).success, true);
      await page.reload();
      await page.setViewportSize({width: 1440, height: 960});
      await page.locator('button[data-section="settings-services"]').click();
      await page.locator('[data-service-value="deeplx"]').click();
      assert.equal(await page.locator('.detail-title-row h4').textContent(), 'DeepLX');
      assert.equal(await page.locator('.detail-title-row [data-service-nature-badge]').textContent(), label);
      assert.equal((await readConfig()).service, 'freeTranslation');
      await shot(`deeplx-badge-${language}-desktop`);
      await page.setViewportSize({width: 390, height: 960});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(`deeplx-badge-${language}-390`);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await shot(`deeplx-badge-${language}-390-dark`);
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    }
    report.caseCoverage.push('separate DeepLX nature badges in the standalone service directory and details; Chinese/English desktop, narrow and dark layouts');
    report.caseCoverage.push('equal card heights in Chinese/English at desktop and narrow widths');
    assert.deepEqual(report.consoleErrors, []);
    report.ok = true;
  } catch (error) {report.error = error.stack || String(error); process.exitCode = 1;}
  finally {
    report.cleanupErrors = [];
    let browserClosed = !launchAttempted;
    if (launched) {
      try {await launched.close(); browserClosed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    if (profileDir) {
      if (browserClosed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true}); report.profileRemoved = true;}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(`free settings report write: ${error.stack || error}`); process.exitCode = 1;}
    console.log(JSON.stringify(report, null, 2));
  }
})();
