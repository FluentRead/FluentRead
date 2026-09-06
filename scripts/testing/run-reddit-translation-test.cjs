#!/usr/bin/env node
/**
 * @file scripts/testing/run-reddit-translation-test.cjs
 * 在全新临时 Edge 中重现用户 HTML 中的沉浸式翻译 font 结构，检查 FluentRead 的
 * 正文/全部节点范围、悬浮切换、全文翻译、迟到响应及外部译文增删。只提供本地夹具
 * 和确定性微软响应，不执行用户粘贴的脚本，不访问外部网络，不激活 macOS 前台。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
const root = path.resolve(__dirname, '../..');
const owned = '.fluent-read-bilingual-content';
const foreign = '.immersive-translate-target-wrapper';
const args = {timeout: 30000};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--background') continue;
  assert.ok(key.startsWith('--') && process.argv[i + 1], `Invalid argument ${key}`);
  args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = process.argv[++i];
}
for (const key of ['extensionDir', 'playwrightRoot', 'focusSafeHelper', 'artifactsDir']) {
  assert.ok(args[key], `Missing ${key}`);
  args[key] = path.resolve(args[key]);
}
args.timeout = Number(args.timeout);
const helper = require(args.focusSafeHelper);
const {chromium} = createRequire(path.join(args.playwrightRoot, 'reddit-test.cjs'))('playwright');
const report = {scope: 'reddit-domain-local-fixture', provider: 'microsoft-local-deterministic-response',
  profileMode: 'new-temporary-profile', cases: [], errors: []};
const save = () => fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));

async function main() {
  assertFreshProductionExtension(args.extensionDir, root);
  fs.mkdirSync(args.artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-reddit-coexistence-'));
  let session, context, worker, popup, sequence = 0;
  const installedWorkers = new WeakMap();
  const installWorker = current => {
    if (!installedWorkers.has(current)) installedWorkers.set(current, current.evaluate(() => {
      globalThis.redditRequests = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') {
          throw new Error(`External worker fetch disabled: ${url.origin}`);
        }
        const texts = JSON.parse(init?.body ?? await input.text());
        globalThis.redditRequests.push(texts);
        await new Promise(resolve => setTimeout(resolve, 600));
        return new Response(JSON.stringify(texts.map(() => ({translations: [{text: '流畅阅读测试译文'}]}))),
          {status: 200, headers: {'content-type': 'application/json'}});
      };
    }));
    return installedWorkers.get(current);
  };
  const patchConfig = async updates => {
    const response = await popup.evaluate(async ({updates, sequence}) => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!read.success) throw new Error(read.error);
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
        expected: Object.fromEntries(Object.keys(updates).map(key => [key, config[key]])),
        clientId: 'reddit-coexistence-browser', sequence, baseRevision: config.__fluentConfigRevision});
    }, {updates, sequence: ++sequence});
    assert.equal(response.success, true, JSON.stringify(response));
  };
  const count = (page, selector) => page.locator(selector).count();
  const waitCount = (page, selector, expected) => page.waitForFunction(({selector, expected}) =>
    document.querySelectorAll(selector).length === expected, {selector, expected}, {timeout: args.timeout});
  const toggleFull = async page => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
  };
  const toggleHover = async (page, selector) => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    const box = await page.locator(selector).boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + 20, box.y + 8);
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
  };
  const addForeign = (page, id) => page.evaluate(id => {
    const wrapper = document.createElement('font');
    wrapper.className = 'notranslate immersive-translate-target-wrapper';
    wrapper.lang = 'zh-CN';
    wrapper.innerHTML = '<br><font data-immersive-translate-translation-element-mark="1">动态外部译文</font>';
    document.getElementById(id).append(wrapper);
    window.foreignNodes.push(wrapper);
  }, id);
  const unique = page => page.evaluate(owned => [...document.querySelectorAll('main p, main h1')]
    .every(node => node.querySelectorAll(owned).length <= 1) && !document.querySelector(`${owned} ${owned}`), owned);
  try {
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true,
      headless: false, viewport: {width: 1280, height: 1000}, displayTarget: 'secondary', timeout: args.timeout,
      browserArgs: [`--disable-extensions-except=${args.extensionDir}`, `--load-extension=${args.extensionDir}`,
        '--no-first-run', '--no-default-browser-check']});
    context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    context.on('serviceworker', current => { void installWorker(current).catch(error => report.errors.push(error.message)); });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: args.timeout});
    await installWorker(worker);
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/translation-pages/reddit-duplicates.html'), 'utf8');
    const url = 'https://www.reddit.com/r/MiniMax_AI/comments/fluentread_fixture/';
    await context.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.url() === url) return route.fulfill({status: 200, contentType: 'text/html', body: fixture});
      if (/^https?:/.test(request.url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    popup = await helper.newPageWithoutForeground(context, args.timeout);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.waitForTimeout(600);
    report.config = {service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false,
      hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'all', useCache: false,
      enableAIContext: false, enableAIMultiSegment: false, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true};
    await patchConfig(report.config);
    for (const scope of ['content', 'all']) {
      await patchConfig({translationScope: scope});
      await worker.evaluate(() => { globalThis.redditRequests = []; });
      const page = await helper.newPageWithoutForeground(context, args.timeout);
      const result = {scope}; report.cases.push(result);
      page.on('pageerror', error => report.errors.push(error.message));
      try {
        await page.goto(url, {waitUntil: 'domcontentloaded'});
        await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
        await page.waitForTimeout(600);
        await page.evaluate(foreign => { window.foreignNodes = [...document.querySelectorAll(foreign)]; }, foreign);
        const original = await page.locator('main').innerHTML();
        const originalReply = await page.locator('#reply').innerHTML();
        result.hoverCounts = [];
        for (const expected of [1, 0, 1]) {
          await toggleHover(page, '#clean'); await waitCount(page, `#clean ${owned}`, expected);
          result.hoverCounts.push(await count(page, `#clean ${owned}`));
          assert.equal(await count(page, `#existing ${owned}`), 0);
        }
        await toggleHover(page, '#clean'); await waitCount(page, owned, 0);
        const requestsBeforeForeignHover = await worker.evaluate(() => globalThis.redditRequests.length);
        await toggleHover(page, '#existing'); await page.waitForTimeout(1000);
        assert.equal(await count(page, owned), 0);
        assert.equal(await worker.evaluate(() => globalThis.redditRequests.length), requestsBeforeForeignHover);
        assert.equal(await page.locator('main').innerHTML(), original);
        await toggleFull(page);
        await page.waitForSelector('#during .fluent-read-loading', {state: 'attached'});
        await addForeign(page, 'during');
        await waitCount(page, `#clean ${owned}`, 1); await waitCount(page, `#after ${owned}`, 1);
        await waitCount(page, '.fluent-read-loading', 0); await page.waitForTimeout(900);
        for (const id of ['post-title-fixture', 'existing', 'during']) assert.equal(await count(page, `#${id} ${owned}`), 0);
        const requestsBeforeLate = await worker.evaluate(() => globalThis.redditRequests.length);
        await addForeign(page, 'after'); await waitCount(page, `#after ${owned}`, 0);
        await page.waitForTimeout(900);
        assert.equal(await worker.evaluate(() => globalThis.redditRequests.length), requestsBeforeLate);
        assert.ok(await unique(page));
        assert.equal(await page.evaluate(() => window.foreignNodes.every(node => node.isConnected)), true);
        assert.equal(await page.locator(`${owned}`).evaluateAll(nodes => nodes.some(node => /其他翻译器|动态外部译文/.test(node.textContent))), false);
        assert.ok(await page.locator(`#terms ${owned}`).textContent().then(text => text.includes('MiniMax') && text.includes('api_key')));
        if (scope === 'content') assert.equal(await page.locator('#reply').textContent(), 'Reply');
        const requests = await worker.evaluate(() => globalThis.redditRequests.flat());
        assert.equal(requests.some(text => /A new model|The model uses sparse|其他翻译器|动态外部译文/.test(text)), false);
        result.beforeRemoval = await count(page, owned);
        await page.locator(`#existing ${foreign}`).evaluate(node => node.remove());
        await waitCount(page, `#existing ${owned}`, 1);
        result.foreignRemovalRetranslates = true;
        await page.screenshot({path: path.join(args.artifactsDir, `${scope}-translated.png`)});
        const sourceWithForeign = await page.locator('main').evaluate((main, {owned, originalReply}) => {
          const clone = main.cloneNode(true);
          clone.querySelectorAll(owned).forEach(node => node.remove());
          // 全部节点范围的按钮使用原位文本槽，恢复预期必须来自翻译前的原始按钮。
          clone.querySelector('#reply').innerHTML = originalReply;
          return clone.innerHTML;
        }, {owned, originalReply});
        await toggleFull(page); await waitCount(page, owned, 0); await page.waitForTimeout(300);
        assert.equal(await page.locator('main').innerHTML(), sourceWithForeign);
        await toggleFull(page); await waitCount(page, `#clean ${owned}`, 1); await waitCount(page, '.fluent-read-loading', 0);
        assert.ok(await unique(page));
        for (const id of ['post-title-fixture', 'during', 'after']) assert.equal(await count(page, `#${id} ${owned}`), 0);
        assert.equal(page.url(), url);
        result.passed = true;
        result.requests = await worker.evaluate(() => globalThis.redditRequests);
        await page.screenshot({path: path.join(args.artifactsDir, `${scope}-retranslated.png`)});
        console.log(`${scope}: hover 1/0/1, no overlap before/during/after requests, restore/retranslate passed`);
      } catch (error) {
        result.error = error.stack;
        result.dom = await page.locator('main').innerHTML().catch(() => '');
        await page.screenshot({path: path.join(args.artifactsDir, `${scope}-failure.png`)}).catch(() => {});
        throw error;
      } finally { save(); await page.close(); }
    }
    assert.deepEqual(report.errors, []); report.passed = true;
  } finally {
    save(); if (session) await session.close();
    fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}
main().catch(error => {process.stderr.write(`${error.stack}\n`); process.exitCode = 1;});
