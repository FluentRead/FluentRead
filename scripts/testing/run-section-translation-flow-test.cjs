'use strict';
/** 局部翻译生产回归：临时隔离 Edge、真实指针与按键手势、确定性翻译传输；验证防抖预览、点击锁定、按钮调整与确认，仅翻译所选区域并验证恢复与退出。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const projectRoot = path.resolve(arg('project-root', path.join(__dirname, '../..')));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-section-flow'));
const githubUrl = arg('github-url');
const playwrightRoot = arg('playwright-root');
const helper = arg('focus-safe-helper');
const caseSet = arg('case-set', 'core');
if (!['core', 'quality', 'all'].includes(caseSet)) throw new Error('--case-set 必须是 core、quality 或 all');
const qualityCases = arg('quality-cases', 'layout,nested-scroll,replacement,boundary,shadow,retry,cancel,performance,narrow').split(',');
const knownQualityCases = ['layout', 'nested-scroll', 'replacement', 'boundary', 'shadow', 'retry', 'cancel', 'performance', 'narrow'];
if (!qualityCases.length || qualityCases.some(name => !knownQualityCases.includes(name)) || new Set(qualityCases).size !== qualityCases.length) throw new Error('--quality-cases 包含未知或重复的专项名称');
if (!playwrightRoot || !helper) throw new Error('必须提供 --playwright-root 和 --focus-safe-helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helper);
const {startFocusEventMonitor} = require('./mac-focus-event-monitor.cjs');
const {getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
fs.mkdirSync(artifacts, {recursive: true});
const temporaryRoot = fs.realpathSync(os.tmpdir());
const profileDir = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-section-flow-'));
const profileIdentity = fs.lstatSync(profileDir);
const owner = crypto.randomUUID();
fs.writeFileSync(path.join(profileDir, '.owner'), owner, {flag: 'wx'});
const report = {scope: 'production extension, trusted CDP pointer/keyboard gestures, deterministic Google transport; not live provider latency or quality', sourceProjectRoot: projectRoot, caseSet, qualityCases: caseSet === 'core' ? [] : qualityCases, cases: [], screenshots: [], errors: [], consoleErrors: [], errorCoverage: 'errors contains uncaught page exceptions; console.error messages are recorded separately, including intentionally failed fixture requests', profileMode: 'automatically-created-temporary-profile'};

const filler = (id, text) => `<p id="${id}">${text}</p>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Section translation fixture</title><style>
body{font:16px/1.6 system-ui;margin:0;color:#1f2328;background:#fff}header,footer{padding:12px 24px;background:#f6f8fa}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:24px;max-width:1100px;margin:0 auto;padding:24px}
.box{border:1px solid #d0d7de;border-radius:6px;padding:16px 24px}#files{margin-bottom:16px}.far{margin-top:1400px}
</style></head><body>
<header id="site-header"><nav id="site-nav"><a href="/pulls">Pull requests</a> · <a href="/issues">Issues</a> · <a href="/explore">Explore the community</a></nav></header>
<div class="layout"><main>
<div id="files" class="box">${filler('file-note', 'Latest commit updated the build scripts and the release workflow.')}</div>
<div id="readme" class="box"><article class="markdown-body" id="readme-body">
<h1 id="readme-title">FluentRead keeps the original text beside every translation</h1>
${filler('p1', 'FluentRead is an open source browser extension for reading foreign pages in your own language.')}
${filler('p2', 'It places the translation next to the original paragraph so you can compare wording, and <a id="inline-link" href="/elsewhere">this link stays clickable</a> after translation.')}
<ul id="features"><li id="li1">Translate a whole page with one shortcut.</li><li id="li2">Translate only the part of the page you care about.</li></ul>
<pre id="code"><code>pnpm install &amp;&amp; pnpm build</code></pre>
${filler('p3', 'Every provider can be switched without reloading the page.')}
<p id="p-far" class="far">This paragraph starts far below the first screen and should still be translated after the visible ones.</p>
</article></div>
<div id="zh-section" class="box"><p id="zh-text">这一段已经是中文，局部翻译不应该再次请求翻译服务。</p></div>
<div id="empty-section" class="box" style="height:80px"><img alt="" width="40" height="40"></div>
<label for="notes">Notes</label><input id="notes" value="type here">
</main>
<aside id="about" class="box"><h2 id="about-title">About</h2><p id="about-text">Translate web pages side by side with the original text.</p></aside>
</div>
<footer id="site-footer"><p id="footer-text">Terms of service and privacy policy for this example project.</p></footer>
<script>window.__pageClicks=0;document.addEventListener('click',()=>{window.__pageClicks+=1;});</script>
</body></html>`;

const server = http.createServer((request, response) => {response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);});
let launched, page, popup, worker, cdp, tabId, focusMonitor, browserPid, focusError, currentCase = 'launch', currentAction = 'launch', traceCount = 0, launchAttempted = false, sequence = 0;
const focusDiagnostic = path.join(artifacts, 'focus-diagnostic.private.jsonl');
report.focusDiagnostic = focusDiagnostic;
function privateFocusRecord(record) {
  fs.appendFileSync(focusDiagnostic, `${JSON.stringify({wallTimeMs: Date.now(), case: currentCase, action: currentAction, ...record})}\n`, {mode: 0o600});
}
function noteAction(action) {
  currentAction = action;
  if (traceCount++ < 2000) privateFocusRecord({kind: 'action'});
}
function tracePageActions(target, label) {
  for (const [surface, names] of [[target.keyboard, ['press', 'down', 'up']], [target.mouse, ['move', 'click']], [target, ['evaluate']]]) {
    for (const name of names) {
      const original = surface[name].bind(surface);
      surface[name] = (...args) => {noteAction(`${label}.${name}: ${String(args[0]).slice(0, 160)}`); return original(...args);};
    }
  }
}

function assertFocusSafe() {
  if (focusError || focusMonitor?.error) throw focusError || focusMonitor.error;
  if (browserPid && focusMonitor?.events.some(event => event.pid === browserPid)) throw new Error('测试 Edge 在专项期间成为前台应用；测试已停止');
}

async function patch(values) {
  noteAction(`configuration patch: ${Object.keys(values).join(',')}`);
  await popup.evaluate(async ({values, sequence}) => {
    const {value: current} = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    const response = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: values,
      expected: Object.fromEntries(Object.keys(values).map(k => [k, current[k]])), clientId: 'section-fixture', sequence, baseRevision: current.__fluentConfigRevision || 0});
    if (!response.success) throw new Error(response.error);
  }, {values, sequence: ++sequence});
}
/** 在封闭 Shadow Root 内执行只读查询；网页脚本本身无法读取该浮层。 */
async function picker(code) {
  const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
  let host;
  const visit = node => {
    const a = node.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-fluent-read-ui' && a[i + 1] === 'section-picker') host = node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  };
  visit(tree.root);
  if (!host?.shadowRoots?.[0]) return null;
  const {object} = await cdp.send('DOM.resolveNode', {nodeId: host.shadowRoots[0].nodeId});
  try {
    const result = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: `function(){${code}}`, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
}
async function wait(test, timeout = 20000, label = currentCase) {
  noteAction(`wait: ${label}`);
  const until = Date.now() + timeout;
  while (Date.now() < until) {assertFocusSafe(); if (await test()) return; await page.waitForTimeout(60);}
  throw new Error(`${label}: 等待超时`);
}
const pickerState = () => picker(`const box=this.querySelector('.fr-section-box'),r=box.getBoundingClientRect();return{visible:box.classList.contains('is-visible'),rect:{x:r.x,y:r.y,width:r.width,height:r.height},action:this.querySelector('.fr-section-label-action')?.textContent,meta:this.querySelector('.fr-section-label-meta')?.textContent,bar:this.querySelector('.fr-section-bar')?.textContent,selection:this.host.getAttribute('data-selection-state'),preview:this.querySelector('.fr-section-bar-preview')?.textContent,confirmDisabled:this.querySelector('.fr-section-confirm')?.disabled}`);
const pickerActive = async () => (await page.locator('[data-fluent-read-ui="section-picker"]').count()) > 0 && Boolean(await picker('return !this.querySelector(".fr-section-bar.is-hidden")'));
async function startFromPopupMessage() {
  noteAction('extension message: start section picker');
  const response = await popup.evaluate(tab => chrome.tabs.sendMessage(tab, {type: 'contextMenuTranslate', action: 'section'}), tabId);
  assert.deepEqual(response, {status: 'success'});
  await wait(pickerActive);
}
async function center(selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, selector);
  return {x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 12)};
}
async function hover(selector) {
  // 选择模式中滚动是原生的；先把目标滚进视口，再用真实指针移过去。
  await page.locator(selector).scrollIntoViewIfNeeded();
  const point = await center(selector);
  await page.mouse.move(point.x, point.y, {steps: 4});
  await page.waitForTimeout(220);
  return point;
}
async function clickPickerButton(selector) {
  const point = await picker(`const b=this.querySelector(${JSON.stringify(selector)});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}`);
  assert(point && !point.disabled, `enabled picker button: ${selector}`);
  await page.mouse.click(point.x, point.y);
}
async function waitLabel(pattern, meta) {
  await wait(async () => {const state = await pickerState(); return state?.visible && pattern.test(state.action || '') && (!meta || state.meta === meta);}, 8000, `${currentCase}: 标签 ${pattern}`);
  return pickerState();
}
const translationCount = selector => page.evaluate(s => [...document.querySelectorAll(s)].filter(n => n.querySelector('.fluent-read-bilingual-content')).length, selector);
const hasTranslation = selector => page.evaluate(s => Boolean(document.querySelector(s)?.querySelector('.fluent-read-bilingual-content')), selector);
// 页面框架内的文字按界面控件处理，译文原位替换文本节点而不是追加双语块，因此按可见文字判断。
const showsTranslation = selector => page.evaluate(s => document.querySelector(s)?.textContent.includes('【译】') === true, selector);
async function shot(name) {const target = path.join(artifacts, `${name}.png`); await page.screenshot({path: target}); report.screenshots.push(target);}
async function noticeText() {return page.evaluate(() => document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.textContent || '');}

(async () => {
  report.buildFreshness = assertFreshProductionExtension(extensionDir, projectRoot);
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  focusMonitor = startFocusEventMonitor({onEvent: event => {
    if (browserPid && event.pid === browserPid) {
      privateFocusRecord({kind: 'owned-browser-activation', ownedPid: browserPid, eventTime: event.time, eventMonotonicMs: event.monotonicMs});
      focusError = new Error('测试 Edge 在专项期间成为前台应用；测试已停止');
    }
  }, onError: error => {focusError = error;}});
  await focusMonitor.ready;
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir,
    browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: false, background: true, displayTarget: arg('display', 'secondary'),
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1280, height: 900}, timeout: 30000});
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground'); assert.equal(report.windowPlacement.browserFrontmost, false);
  const context = launched.context;
  const browserSession = await context.browser().newBrowserCDPSession();
  try {
    const {processInfo} = await browserSession.send('SystemInfo.getProcessInfo');
    browserPid = processInfo.find(process => process.type === 'browser')?.id;
    assert.ok(browserPid, 'focus observer has the owned browser PID');
    const guardedPid = await getGuardedBrowserPid(launched);
    assert.equal(browserPid, guardedPid, 'focus observer PID matches the ownership guard and current CDP browser');
    privateFocusRecord({kind: 'owned-browser-identity', ownedPid: browserPid, guardedPid, cdpPid: browserPid});
    for (const event of focusMonitor.events.filter(event => event.pid === browserPid)) privateFocusRecord({kind: 'owned-browser-activation-before-identity', ownedPid: browserPid, eventTime: event.time, eventMonotonicMs: event.monotonicMs});
  } finally {await browserSession.detach();}
  assertFocusSafe();
  worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
  popup = await newPageWithoutForeground(context, 30000);
  await popup.setViewportSize({width: 400, height: 760});
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await patch({on: true, service: 'google', from: 'auto', to: 'zh-Hans', display: 1, disableFloatingBall: true, disableSelectionTranslator: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true});
  await worker.evaluate(() => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.__sectionFixture = {origins: [], requests: [], transports: [], delayMs: 60, failureMatch: '', active: 0, maxActive: 0};
    const settleFixture = async (origins) => {
      const fixture = globalThis.__sectionFixture;
      const entry = {origins, startedAt: performance.now(), delayMs: fixture.delayMs, failed: Boolean(fixture.failureMatch && origins.some(text => text.includes(fixture.failureMatch)))};
      fixture.transports.push(entry);
      fixture.active += 1;
      fixture.maxActive = Math.max(fixture.maxActive, fixture.active);
      try {
        await new Promise(resolve => setTimeout(resolve, entry.delayMs));
        return entry.failed;
      } finally {entry.finishedAt = performance.now(); fixture.active -= 1;}
    };
    globalThis.fetch = async (input, options) => {
      const url = String(typeof input === 'string' ? input : input.url || input);
      const translateFixture = (origin, source, target) => {
        globalThis.__sectionFixture.origins.push(origin);
        globalThis.__sectionFixture.requests.push({origin, source, target, requestedAt: performance.now()});
        return origin.split(/(___FLUENTREAD_[A-Za-z0-9]+_\d+_(?:BEGIN|END)___)/)
          .map(part => part.startsWith('___FLUENTREAD_') || !part.trim() ? part : `【译】${part}`).join('');
      };
      if (url.includes('/v1/translateHtml')) {
        const [texts, source, target] = JSON.parse(options.body)[0];
        const translated = texts.map(text => `<pre>${translateFixture(text.replace(/^<pre>|<\/pre>$/g, ''), source, target)}</pre>`);
        if (await settleFixture(texts)) return new Response('Section fixture request intentionally rejected', {status: 400});
        return new Response(JSON.stringify([translated]), {status: 200});
      }
      if (url.includes('/translate_a/t')) {
        const parsed = new URL(url), body = new URLSearchParams(options.body);
        const translated = body.getAll('q').map(text => translateFixture(text, parsed.searchParams.get('sl'), parsed.searchParams.get('tl')));
        if (await settleFixture(body.getAll('q'))) return new Response('Section fixture request intentionally rejected', {status: 400});
        return new Response(JSON.stringify(translated), {status: 200});
      }
      if (url.includes('/_/TranslateWebserverUi/data/batchexecute')) {
        const origins = [];
        const records = JSON.parse(new URLSearchParams(options.body).get('f.req'))[0].map(rpc => {
          const [origin, source, target] = JSON.parse(rpc[1])[0];
          origins.push(origin);
          const entry = [null, null, null, null, null, [[translateFixture(origin, source, target)]]];
          return ['wrb.fr', 'MkEWBc', JSON.stringify([null, [[entry]]]), null, null, null, rpc[3]];
        });
        if (await settleFixture(origins)) return new Response('Section fixture request intentionally rejected', {status: 400});
        return new Response(JSON.stringify(records), {status: 200});
      }
      return original(input, options);
    };
  });

  currentCase = 'popup shows the section entry next to the page action';
  await popup.reload(); await popup.waitForSelector('[data-config-ready="true"]');
  const popupButton = popup.locator('[data-testid="section-translation"]');
  assert.equal(await popupButton.count(), 1);
  assert.match(await popupButton.getAttribute('aria-label'), /局部翻译/);
  const popupGeometry = await popup.evaluate(() => {
    const main = document.querySelector('.translate-button').getBoundingClientRect(), section = document.querySelector('[data-testid="section-translation"]').getBoundingClientRect();
    return {mainRight: main.right, sectionLeft: section.left, sameTop: Math.abs(main.top - section.top) < 1, sameHeight: Math.abs(main.height - section.height) < 1, overflow: document.documentElement.scrollWidth > innerWidth};
  });
  assert.ok(popupGeometry.sectionLeft > popupGeometry.mainRight && popupGeometry.sameTop && popupGeometry.sameHeight && !popupGeometry.overflow, JSON.stringify(popupGeometry));
  report.popupGeometry = popupGeometry;
  const popupShot = path.join(artifacts, '00-popup.png'); await popup.locator('.hero-card').screenshot({path: popupShot}); report.screenshots.push(popupShot);
  report.cases.push(currentCase);

  page = await newPageWithoutForeground(context, 30000); page.on('pageerror', e => report.errors.push(e.message));
  tracePageActions(page, 'fixturePage');
  page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({case: currentCase, message: message.text(), location: message.location()});});
  await page.goto(`http://127.0.0.1:${server.address().port}/repo`); cdp = await context.newCDPSession(page);
  await activateExtensionTabWithoutForeground(context, page, 30000);
  tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(tabId, 'fixture tab id');
  await page.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: 20000});
  const pageUrl = page.url();

  if (caseSet !== 'quality') {
  currentCase = 'locked closed-shadow toolbar handles range keys and Escape after webpage input focus';
  await page.locator('#notes').focus();
  await startFromPopupMessage();
  await hover('#p1');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal((await pickerState()).meta, '段落', 'webpage input keeps its editing keys before locking');
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), 0);
  const lockPoint = await center('#p1');
  await page.mouse.click(lockPoint.x, lockPoint.y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-fluent-read-ui="section-picker"]')), true, 'closed shadow focus is retargeted to the picker host');
  await page.keyboard.press('ArrowUp');
  await waitLabel(/翻译此区域 · 7 段/, '文章');
  await page.keyboard.press('ArrowDown');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await shot('00-locked-keyboard-range');
  await page.keyboard.press('Escape');
  await wait(async () => !(await pickerActive()), 3000);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes', 'Escape restores previous input focus');
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), 0, 'Escape cancels without a request');
  await page.locator('#notes').evaluate(element => element.blur());
  await page.evaluate(() => scrollTo(0, 0));
  report.cases.push(currentCase);

  currentCase = 'toolbar buttons keep range keys and native Enter activation after Tab';
  await startFromPopupMessage();
  await hover('#p1');
  const buttonLockPoint = await center('#p1');
  await page.mouse.click(buttonLockPoint.x, buttonLockPoint.y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await page.keyboard.press('Tab');
  assert.equal(await picker('return this.activeElement?.classList.contains("fr-section-bar-close")'), true, 'Tab focuses the close button');
  await page.keyboard.press('ArrowUp');
  await waitLabel(/翻译此区域 · 7 段/, '文章');
  await page.keyboard.press('ArrowDown');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('Enter');
  await wait(async () => !(await pickerActive()), 3000);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), 0, 'Enter activates close without translation');
  report.cases.push(currentCase);

  currentCase = 'stable boundary preview, explicit locking, visible range buttons and reselect';
  await startFromPopupMessage();
  await hover('#p1');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  const boundary = await page.locator('#p1').boundingBox();
  const firstRect = (await pickerState()).rect;
  for (const offset of [2, -2, 3, -1, 2, -3]) {
    await page.mouse.move(boundary.x + 8, boundary.y + boundary.height + offset);
    await page.waitForTimeout(30);
    assert.deepEqual((await pickerState()).rect, firstRect, 'boundary jitter keeps the paragraph');
  }
  await hover('#p1');
  await page.mouse.click((await center('#p1')).x, (await center('#p1')).y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await hover('#about-text');
  assert.equal((await pickerState()).meta, '段落');
  await clickPickerButton('.fr-section-expand');
  await waitLabel(/翻译此区域 · 7 段/, '文章');
  await clickPickerButton('.fr-section-shrink');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await shot('00-locked-range-controls');
  await clickPickerButton('.fr-section-reselect');
  assert.equal((await pickerState()).selection, 'preview');
  await hover('#p2');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  assert.match((await pickerState()).preview, /It places the translation/);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), 0);
  await page.keyboard.press('Escape');
  report.cases.push(currentCase);

  currentCase = 'picker highlights the paragraph under the pointer and widens with ArrowUp';
  await startFromPopupMessage();
  assert.equal(await page.evaluate(() => document.querySelector('[data-fluent-read-ui="section-picker"]').shadowRoot), null, 'closed shadow root');
  assert.match((await pickerState()).bar, /局部翻译.*移动鼠标预览/);
  await hover('#p1');
  let state = await waitLabel(/翻译此区域 · 1 段/, '段落');
  const p1Box = await page.locator('#p1').boundingBox();
  // 高亮框向外留 3px，完整包住段落又不压住文字。
  assert.ok(Math.abs(state.rect.x - (p1Box.x - 3)) < 2 && Math.abs(state.rect.width - (p1Box.width + 6)) < 2, JSON.stringify({state, p1Box}));
  await page.keyboard.press('ArrowUp');
  state = await waitLabel(/翻译此区域 · \d+ 段/, '文章');
  report.readmeLabel = state.action;
  await shot('01-picker-readme');
  // 扩大后鼠标在 README 内移动不会跳回小段落。
  await hover('#inline-link');
  state = await pickerState(); assert.equal(state.meta, '文章');
  report.cases.push(currentCase);

  currentCase = 'click locks the section without navigation or requests; Enter confirms only that section';
  const linkPoint = await center('#inline-link');
  const beforeLock = await worker.evaluate(() => globalThis.__sectionFixture.origins.length);
  await page.mouse.click(linkPoint.x, linkPoint.y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await page.waitForTimeout(150);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), beforeLock, 'lock does not translate');
  assert.equal((await pickerState()).confirmDisabled, false);
  await hover('#about-text');
  assert.equal((await pickerState()).meta, '文章', 'locked section survives mouse movement and scrolling');
  await page.keyboard.press('Enter');
  await wait(async () => !(await pickerActive()), 5000);
  assert.equal(page.url(), pageUrl, 'link must not navigate');
  assert.equal(await page.evaluate(() => window.__pageClicks), 0, 'page must not receive the picking click');
  const readmeTargets = ['#readme-title', '#p1', '#p2', '#li1', '#li2', '#p3', '#p-far'];
  await wait(async () => (await translationCount(readmeTargets.join(','))) === readmeTargets.length, 30000);
  for (const outside of ['#site-nav', '#file-note', '#zh-text', '#about-text', '#footer-text', '#code']) assert.equal(await hasTranslation(outside), false, `${outside} must stay original`);
  const origins = await worker.evaluate(() => globalThis.__sectionFixture.origins);
  report.requestOrder = origins.map(text => text.slice(0, 48));
  const outsideText = ['Latest commit', 'Pull requests', 'Explore the community', 'side by side', 'Terms of service', '这一段', 'pnpm install'];
  assert.ok(origins.every(origin => !outsideText.some(text => origin.includes(text))), 'no request for content outside the section');
  const indexOf = text => origins.findIndex(origin => origin.includes(text));
  const farIndex = indexOf('far below the first screen');
  for (const visible of ['FluentRead keeps the original', 'FluentRead is an open source', 'It places the translation', 'Every provider can be switched']) {
    assert.ok(indexOf(visible) >= 0 && indexOf(visible) < farIndex, `${visible} is requested before content below the fold`);
  }
  assert.equal(await page.evaluate(() => document.querySelector('#p2 a#inline-link')?.getAttribute('href')), '/elsewhere', 'link survives translation');
  assert.equal(await page.evaluate(() => document.querySelector('#p1 .fluent-read-bilingual-content').textContent.includes('【译】')), true);
  await shot('02-readme-translated');
  report.cases.push(currentCase);

  currentCase = 'picking the translated section again restores only that section';
  await startFromPopupMessage();
  await hover('#p2');
  await waitLabel(/恢复原文 · 1 段/, '段落');
  await page.keyboard.press('ArrowUp');
  state = await waitLabel(/恢复原文 · 7 段/, '文章');
  await shot('03-picker-restore-label');
  await page.keyboard.press('Enter');
  await wait(async () => (await translationCount(readmeTargets.join(','))) === 0, 10000);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-fr-translation-owned="true"]').length), 0);
  report.cases.push(currentCase);

  currentCase = 'Escape, right-click and forged events leave the page untouched';
  await startFromPopupMessage(); await hover('#p1'); await waitLabel(/翻译此区域/);
  await page.evaluate(() => document.querySelector('#p1').dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 10, clientY: 10})));
  assert.equal(await pickerActive(), true, 'synthetic click must not pick');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
  assert.equal(await pickerActive(), true, 'synthetic Escape must not exit');
  await page.keyboard.press('Escape');
  await wait(async () => (await page.locator('[data-fluent-read-ui="section-picker"]').count()) === 0, 3000);
  await startFromPopupMessage(); await hover('#p1');
  await page.mouse.click((await center('#p1')).x, (await center('#p1')).y, {button: 'right'});
  await wait(async () => (await page.locator('[data-fluent-read-ui="section-picker"]').count()) === 0, 3000);
  await page.waitForTimeout(500);
  assert.equal(await hasTranslation('#p1'), false);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), origins.length, 'no new request after exits');
  report.cases.push(currentCase);

  currentCase = 'picking page chrome translates it even though page translation keeps it original';
  await startFromPopupMessage(); await hover('#about-text'); await page.keyboard.press('ArrowUp');
  await waitLabel(/翻译此区域 · 2 段/, '区域');
  await page.keyboard.press('Enter');
  await wait(async () => (await showsTranslation('#about-title')) && (await showsTranslation('#about-text')), 20000);
  assert.equal(await hasTranslation('#p1'), false);
  await shot('04-sidebar-translated');
  report.cases.push(currentCase);

  currentCase = 'same-language and empty sections explain why nothing was requested';
  const beforeSame = await worker.evaluate(() => globalThis.__sectionFixture.origins.length);
  await startFromPopupMessage(); await hover('#zh-text'); await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('Enter');
  await wait(async () => /已经是目标语言/.test(await noticeText()), 8000);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.origins.length), beforeSame);
  await startFromPopupMessage(); await hover('#zh-text'); await waitLabel(/已是目标语言，无需翻译/, '段落');
  await page.locator('#empty-section').evaluate(element => element.scrollIntoView({block: 'center'}));
  const emptyBox = await page.locator('#empty-section').boundingBox();
  await page.mouse.move(emptyBox.x + 8, emptyBox.y + 8, {steps: 3});
  await waitLabel(/没有可翻译的文字/, '区域');
  await page.keyboard.press('Escape');
  report.cases.push(currentCase);

  currentCase = 'optional shortcut enters and leaves picking, and yields to typing';
  await page.keyboard.press('Alt+R'); await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-fluent-read-ui="section-picker"]').count(), 0, 'shortcut is off by default');
  await patch({sectionTranslationHotkeyEnabled: true});
  await page.waitForTimeout(300);
  await hover('#p3');
  await page.keyboard.press('Alt+R');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('Alt+R');
  await wait(async () => (await page.locator('[data-fluent-read-ui="section-picker"]').count()) === 0, 3000);
  await page.locator('#notes').focus(); await page.keyboard.press('Alt+R'); await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-fluent-read-ui="section-picker"]').count(), 0, 'typing keeps the shortcut');
  await page.locator('#readme-title').click();
  report.cases.push(currentCase);

  currentCase = 'restoring page translation also restores translated sections';
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal(await showsTranslation('#about-text'), true);
  await popup.evaluate(tab => chrome.tabs.sendMessage(tab, {type: 'contextMenuTranslate', action: 'restore'}), tabId);
  await wait(async () => (await page.evaluate(() => document.querySelectorAll('.fluent-read-bilingual-content, [data-fr-translation-owned="true"]').length)) === 0, 5000);
  assert.equal(await page.evaluate(() => document.querySelector('#about-text').textContent), 'Translate web pages side by side with the original text.');
  report.cases.push(currentCase);

  currentCase = 'independent section shortcut selects a container before requesting its target language';
  const sectionProfile = {id: 'section-ja', enabled: true, action: 'section', hotkey: 'F8', service: 'google', model: '', targetLanguage: 'ja', displayMode: 'bilingual', fullPageMode: 'inherit'};
  await patch({sectionTranslationHotkeyEnabled: false, quickTranslationProfiles: [sectionProfile]});
  await page.waitForTimeout(300);
  await hover('#p2');
  const beforeProfile = await worker.evaluate(() => globalThis.__sectionFixture.requests.length);
  await page.keyboard.press('F8');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.requests.length), beforeProfile, 'shortcut only starts picking');
  await page.keyboard.press('ArrowUp');
  await waitLabel(/翻译此区域 · 7 段/, '文章');
  await page.keyboard.press('Enter');
  await wait(async () => (await translationCount(readmeTargets.join(','))) === readmeTargets.length, 30000);
  const profileRequests = await worker.evaluate(offset => globalThis.__sectionFixture.requests.slice(offset), beforeProfile);
  assert.ok(profileRequests.length > 0 && profileRequests.every(request => request.target === 'ja'), 'independent language reaches the provider');
  for (const outside of ['#site-nav', '#file-note', '#zh-text', '#about-text', '#footer-text', '#code']) assert.equal(await hasTranslation(outside), false, `${outside} must stay original`);
  assert.equal(page.url(), pageUrl);
  await shot('07-profile-container-translated');
  report.cases.push(currentCase);

  currentCase = 'another section profile switches the container language, and the same profile restores it';
  const alternate = {...sectionProfile, id: 'section-fr', hotkey: 'F9', targetLanguage: 'fr'};
  await patch({quickTranslationProfiles: [sectionProfile, alternate]});
  await page.waitForTimeout(300);
  const beforeSwitch = await worker.evaluate(() => globalThis.__sectionFixture.requests.length);
  await hover('#p2'); await page.keyboard.press('F9');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('ArrowUp'); await waitLabel(/翻译此区域 · 7 段/, '文章');
  await page.keyboard.press('Enter');
  await wait(async () => (await worker.evaluate(offset => globalThis.__sectionFixture.requests.slice(offset).filter(request => request.target === 'fr').length, beforeSwitch)) >= 7, 30000);
  await wait(async () => (await translationCount(readmeTargets.join(','))) === readmeTargets.length, 30000);
  await hover('#p2'); await page.keyboard.press('F9');
  await waitLabel(/恢复原文 · 1 段/, '段落');
  await page.keyboard.press('ArrowUp'); await waitLabel(/恢复原文 · 7 段/, '文章');
  await page.keyboard.press('Enter');
  await wait(async () => (await translationCount(readmeTargets.join(','))) === 0, 10000);
  report.cases.push(currentCase);

  currentCase = 'section profile yields while editing and cancels without translation';
  await page.locator('#notes').focus(); await page.keyboard.press('F8'); await page.waitForTimeout(200);
  assert.equal(await pickerActive(), false, 'profile shortcut yields while typing');
  await page.locator('#p1').click(); await hover('#p1'); await page.keyboard.press('F8');
  await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('F8');
  await wait(async () => !(await pickerActive()), 3000);
  await page.waitForTimeout(350);
  await page.keyboard.press('F8'); await waitLabel(/翻译此区域 · 1 段/, '段落');
  await page.keyboard.press('Escape'); await wait(async () => !(await pickerActive()), 3000);
  assert.equal(await translationCount(readmeTargets.join(',')), 0, 'cancel does not translate');
  report.cases.push(currentCase);

  currentCase = 'narrow layout keeps all range controls and confirmation within the viewport';
  await page.setViewportSize({width: 390, height: 780});
  await startFromPopupMessage();
  await hover('#p1');
  await page.mouse.click((await center('#p1')).x, (await center('#p1')).y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await wait(async () => (await pickerState())?.confirmDisabled === false);
  const narrow = await picker(`const buttons=[...this.querySelectorAll('.fr-section-button,.fr-section-bar-close')];return buttons.map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})`);
  assert.equal(narrow.length, 5);
  assert(narrow.every(button => button.left >= 0 && button.right <= 390 && button.top >= 0 && button.bottom <= 780), JSON.stringify(narrow));
  report.narrowControls = narrow;
  await shot('09-narrow-locked-controls');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 1280, height: 900});
  report.cases.push(currentCase);

  currentCase = 'new nested open ShadowRoots keep locked empty-to-source summaries current';
  const beforeShadow = await worker.evaluate(() => globalThis.__sectionFixture.requests.length);
  await page.evaluate(() => {
    const region = document.createElement('section');
    region.id = 'dynamic-shadow-region';
    region.style.cssText = 'margin:20px;padding:24px;min-height:140px;border:1px solid #aaa';
    document.body.appendChild(region);
  });
  await startFromPopupMessage();
  const shadowPoint = await hover('#dynamic-shadow-region');
  await waitLabel(/没有可翻译的文字/);
  await page.mouse.click(shadowPoint.x, shadowPoint.y);
  await wait(async () => (await pickerState())?.selection === 'locked' && (await pickerState())?.confirmDisabled === true);
  await page.evaluate(() => {
    const host = document.createElement('div');
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = '<p id="dynamic-source"></p>';
    document.querySelector('#dynamic-shadow-region').appendChild(host);
    window.__sectionShadowRoot = root;
  });
  await page.waitForTimeout(180);
  assert.equal((await pickerState()).confirmDisabled, true);
  await page.evaluate(() => {window.__sectionShadowRoot.querySelector('p').textContent = 'New English content inside a dynamically inserted web component.';});
  await waitLabel(/翻译此区域 · 1 段/);
  assert.equal((await pickerState()).confirmDisabled, false);
  await page.evaluate(() => {
    const host = document.createElement('div');
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = '<p id="nested-source"></p>';
    window.__sectionShadowRoot.appendChild(host);
    window.__sectionNestedRoot = root;
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {window.__sectionNestedRoot.querySelector('p').textContent = 'Nested dynamic content must also refresh the locked reading region.';});
  await waitLabel(/翻译此区域 · 2 段/);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.requests.length), beforeShadow, 'preview and topology discovery send no provider requests');
  await shot('10-dynamic-shadow-locked');
  await clickPickerButton('.fr-section-confirm');
  await wait(async () => page.evaluate(() => [window.__sectionShadowRoot, window.__sectionNestedRoot].every(root => root.querySelector('p .fluent-read-bilingual-content'))), 20000);
  assert.equal(await page.evaluate(() => window.__sectionShadowRoot.querySelector('p').firstChild.textContent), 'New English content inside a dynamically inserted web component.');
  const afterShadow = await worker.evaluate(() => globalThis.__sectionFixture.requests.length);
  await page.waitForTimeout(1000);
  assert.equal(await worker.evaluate(() => globalThis.__sectionFixture.requests.length), afterShadow, 'translated shadow content does not loop or repeat requests');
  report.dynamicShadow = {paragraphs: 2, originalPreserved: true, requestCountStableForMs: 1000};
  report.cases.push(currentCase);

  currentCase = 'turning the plugin off exits picking and rejects new requests';
  await startFromPopupMessage();
  await patch({on: false});
  await wait(async () => (await page.locator('[data-fluent-read-ui="section-picker"]').count()) === 0, 5000);
  assert.deepEqual(await popup.evaluate(tab => chrome.tabs.sendMessage(tab, {type: 'contextMenuTranslate', action: 'section'}), tabId), {status: 'disabled'});
  await patch({on: true});
  report.cases.push(currentCase);
  }

  if (caseSet !== 'core') {
    await require('./section-translation-quality-cases.cjs').runSectionQualityCases({
      page, worker, popup, tabId, report, patch, startFromPopupMessage, picker, pickerState, pickerActive,
      hover, center, clickPickerButton, wait, waitLabel, hasTranslation, translationCount, shot, noticeText,
      setCurrentCase: name => {currentCase = name;},
      selectedCases: qualityCases,
    });
  }

  if (githubUrl && caseSet !== 'quality') {
    currentCase = 'real GitHub README section';
    report.githubEvidence = {url: githubUrl, webpage: 'real remote GitHub DOM', translationTransport: 'deterministic Google fixture, not live provider'};
    const githubRequestOffset = await worker.evaluate(() => globalThis.__sectionFixture.requests.length);
    await page.goto(githubUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('article.markdown-body p', {timeout: 30000});
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: 20000});
    await activateExtensionTabWithoutForeground(context, page, 30000);
    await page.evaluate(() => document.querySelector('article.markdown-body').scrollIntoView({block: 'start'}));
    await page.waitForTimeout(500);
    const firstParagraph = page.locator('article.markdown-body p').filter({hasText: /[A-Za-z]{4}/}).first();
    await firstParagraph.scrollIntoViewIfNeeded();
    await startFromPopupMessage();
    const box = await firstParagraph.boundingBox();
    await page.mouse.move(box.x + 8, box.y + Math.min(box.height / 2, 10), {steps: 4});
    await waitLabel(/翻译此区域/);
    for (let attempt = 0; attempt < 8 && (await pickerState()).meta !== '文章'; attempt += 1) {
      await page.keyboard.press('ArrowUp'); await page.waitForTimeout(150);
    }
    const state = await pickerState(); report.githubLabel = state;
    assert.equal(state.meta, '文章');
    await shot('10-github-picker');
    await page.keyboard.press('Enter');
    await wait(async () => (await page.evaluate(() => document.querySelectorAll('article.markdown-body .fluent-read-bilingual-content').length)) > 0, 30000);
    await page.waitForTimeout(2000);
    report.githubTranslated = await page.evaluate(() => ({
      inside: document.querySelectorAll('article.markdown-body .fluent-read-bilingual-content').length,
      outside: [...document.querySelectorAll('.fluent-read-bilingual-content')].filter(n => !n.closest('article.markdown-body')).length,
    }));
    assert.equal(report.githubTranslated.outside, 0, 'only the README is translated');
    report.githubEvidence.fixtureRequests = await worker.evaluate(offset => globalThis.__sectionFixture.requests.length - offset, githubRequestOffset);
    assert.ok(report.githubEvidence.fixtureRequests > 0, 'real GitHub DOM still uses the controlled translation transport');
    await shot('11-github-readme-translated');
    report.cases.push(currentCase);
  }

  assertFocusSafe();
  assert.deepEqual(report.errors, []); report.success = true;
})().catch(async error => {report.success = false; report.failure = {case: currentCase, message: error.stack}; process.exitCode = 1; if (page) await shot('failure').catch(() => {});}).finally(async () => {
  let closed = !launchAttempted;
  try {if (launched) {await launched.close(); closed = true;}} catch (error) {report.cleanupError = error.message; process.exitCode = 1;}
  if (focusMonitor) {
    try {
      await focusMonitor.stop();
      report.focusEvents = {monitoring: 'native macOS activation events throughout the test', browserActivations: focusMonitor.events.filter(event => event.pid === browserPid).length, observerClosed: true};
      assertFocusSafe();
    } catch (error) {report.focusError = error.message; report.success = false; process.exitCode = 1;}
  }
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  if (closed) {const stat = fs.lstatSync(profileDir); assert.ok(!stat.isSymbolicLink() && stat.ino === profileIdentity.ino && stat.dev === profileIdentity.dev); assert.equal(fs.readFileSync(path.join(profileDir, '.owner'), 'utf8'), owner); fs.rmSync(profileDir, {recursive: true}); report.profileRemoved = true;}
  else report.retainedProfile = profileDir;
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
});
