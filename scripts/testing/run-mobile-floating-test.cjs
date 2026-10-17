#!/usr/bin/env node
/**
 * @file scripts/testing/run-mobile-floating-test.cjs
 * 文件职责：用独立可见后台 Edge 验证生产触摸悬浮工具、网页翻译与可见视口定位。
 * 主要内容：可信触摸操作验证翻译、恢复、重译、拖动与刷新，390px/横屏/深色 Popup 和明确标记的软键盘几何夹具。
 * 模块边界：只使用临时 profile 和本地 HTTP 阅读页，不操作用户已有浏览器；只在共享 ownership guard 确认关闭成功后删除 profile。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const {patchStoredConfig} = require('../run-selection-trigger-test.cjs');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(process.argv[i].startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Expected --name value arguments');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
for (const field of ['extension-dir', 'playwright-root', 'artifacts-dir']) assert(args[field], `Missing --${field}`);
const helper = require(args['focus-safe-helper'] ? path.resolve(args['focus-safe-helper']) : './focus-safe-browser.cjs');
const extensionDir = path.resolve(args['extension-dir']);
const artifactsDir = path.resolve(args['artifacts-dir']);
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const {chromium} = createRequire(path.join(path.resolve(args['playwright-root']), 'page-notice-runner.cjs'))('playwright');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-mobile-floating-'));
fs.mkdirSync(artifactsDir, {recursive: true});
const report = {ok: false, suite: 'mobile-floating', extensionDir, profileDir,
  build: extensionDir.endsWith('-dev') ? 'development' : 'production', cases: [], screenshots: [], consoleErrors: [], stages: [], focusSamples: [],
  unverified: ['physical Android/iOS devices', 'Safari and Firefox runtime', 'actual native keyboard', 'live translation providers'],
  fixturePolicy: 'Production extension with local Microsoft response transport; trusted CDP touch input; isolated-world VisualViewport fixture explicitly does not represent native mobile keyboard.'};
const save = () => fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>阅读资料 · 页面提示专项</title><style>
body{margin:0;background:#f6f7fa;color:#293244;font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{height:72px;border-bottom:1px solid #e3e6ed;background:white;display:flex;align-items:center;padding:0 28px;gap:32px}header strong{color:#455467;font-size:17px}nav{display:flex;gap:22px;color:#788296;font-size:14px}main{max-width:740px;margin:62px auto;padding:0 24px}h1{font-size:30px;line-height:1.35;margin:0 0 10px}.meta{color:#8190a2;font-size:14px;margin-bottom:28px}article{background:white;border:1px solid #e3e6ed;border-radius:14px;padding:24px 30px}article p{margin:0 0 22px}article p:last-child{margin-bottom:0}#page-action{border:1px solid #cbd2dc;background:white;border-radius:7px;color:#455467;padding:5px 12px;cursor:pointer}@media(max-width:600px){header{padding:0 16px;gap:18px}nav{gap:12px}main{margin-top:42px;padding:0 16px}h1{font-size:25px}article{padding:20px}}
</style></head><body><header><strong>阅读资料</strong><nav><span>首页</span><span>文章</span><span>收藏</span></nav></header><main><h1>Reading with a little more focus</h1><div class="meta">浏览器阅读示例 · 4 分钟</div><article>
<p id="first">Reading on the web should feel comfortable. A browser tool can highlight important words, translate a difficult passage, or explain unfamiliar expressions without covering the content you are trying to read.</p>
<p>Small pieces of feedback work best when they stay close to the action and use only the space they need. A clear result, a familiar icon, and an easy close button help readers understand what happened and continue reading.</p>
<p>When an action needs more explanation, its message can wrap naturally. The rest of the page should remain available, and the reader should be able to pause the message while looking at it.</p>
</article><p><button id="page-action" onclick="window.__pageClicks=(window.__pageClicks||0)+1">继续阅读</button></p></main></body></html>`;
let translationDelayMs = 2500;
const server = http.createServer(async (request, response) => {
  if (request.url === '/translate') {
    const chunks=[]; for await (const chunk of request) chunks.push(chunk);
    const texts=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (translationDelayMs) await new Promise(resolve=>setTimeout(resolve,translationDelayMs));
    response.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});
    response.end(JSON.stringify(texts.map(text=>({translations:[{text:String(text).includes('Reading with') ? '让阅读更专注' : String(text).includes('Reading on') ? '网页阅读应该舒适自然。浏览器工具可以标出重点词语、翻译难懂的段落，或解释陌生表达，同时保留正在阅读的内容。' : String(text).includes('Small pieces') ? '简洁的反馈应紧邻操作，只占必要空间。清晰的结果、熟悉的图标和方便的关闭按钮，帮助读者理解变化并继续阅读。' : '需要更多解释时，提示应自然换行。页面的其他区域仍然可用，读者也可以暂停提示，慢慢查看。'}]})))); return;
  }
  response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(fixture);
});

(async () => {
  let session, focusMonitor, browserPid, primaryError, focusError, cleanupStarted = false, focusTimer, ownedClosePromise;
  let ownedBrowserClosing = false;
  function closeOwnedBrowser() {
    if (!session) return Promise.resolve();
    ownedClosePromise ||= (async () => {
      ownedBrowserClosing = true;
      const errors = []; let timer;
      try {if (browserPid) {
        // CDP 连接的 browser.close() 仅断开传输；先请求本次精确归属实例正常退出，仍由原 guard 核实 PID 消失。
        report.gracefulBrowserClose = {requestedAt: Date.now(), method: 'Browser.close'}; save();
        await Promise.race([
          (async () => {const cdp = await session.context.browser().newBrowserCDPSession(); await cdp.send('Browser.close');})(),
          new Promise((resolve, reject) => {timer = setTimeout(() => reject(new Error('Owned Browser.close exceeded 1500ms')), 1500);}),
        ]);
        report.gracefulBrowserClose.returnedAt = Date.now();
      }} catch (error) {errors.push(error); if (report.gracefulBrowserClose) report.gracefulBrowserClose.error = String(error);}
      finally {
        clearTimeout(timer);
        // 报告写入或协议退出失败也必须完成原 guard 的清理；只有它成功才有 PID 消失凭据。
        try {await session.close(); report.browserCloseReceipt = 'shared-guard-fulfilled';} catch (error) {errors.push(error);}
      }
      try {save();} catch (error) {errors.push(error);}
      if (errors.length) throw new AggregateError(errors, 'Owned browser close failed');
    })();
    return ownedClosePromise;
  }
  let rejectFatal;
  const fatal = new Promise((resolve, reject) => {rejectFatal = reject;});
  void fatal.catch(() => {});
  const fail = error => {
    focusError ||= error; primaryError ||= error; report.ok = false; report.error = error.stack || String(error); save(); rejectFatal(error);
    void closeOwnedBrowser().catch(closeError => {report.asynchronousCloseError = String(closeError); save();});
  };
  async function step(name, action, timeoutMs = 30000, ignoreFatal = false) {
    report.stage = name; report.stages.push({name, state: 'before', at: Date.now()}); save();
    let timer;
    try {
      const work = Promise.resolve().then(action);
      const timeout = new Promise((resolve, reject) => {timer = setTimeout(() => reject(new Error(`Timed out in ${name}`)), timeoutMs);});
      const result = await Promise.race(ignoreFatal ? [work, timeout] : [work, timeout, fatal]);
      report.stages.push({name, state: 'after', at: Date.now()}); save(); return result;
    } catch (error) {report.stages.push({name, state: 'failed', error: String(error), at: Date.now()}); throw error;}
    finally {clearTimeout(timer);}
  }
  try {
    await step('fixture-listen', () => new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);}));
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/reading`;
    focusMonitor = helper.startFocusEventMonitor({onEvent(event) {
      report.focusEvents = [...focusMonitor.events]; save();
      if (browserPid && event.pid === browserPid) fail(new Error('Owned test browser activated during native focus observation'));
    }, onError: fail});
    report.focusObserver = await step('native-focus-observer', () => focusMonitor.ready, 35000);
    const launching = helper.launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false, displayTarget: 'secondary',
      browserPath: args['browser-path'] || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', viewport: {width: 1440, height: 1000}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    void launching.then(async late => {
      if (!session && (cleanupStarted || focusError)) {
        guardBrowserClose(late, profileDir);
        try {await late.close(); report.lateLaunchCleanup = 'guarded-close-complete';} catch (error) {report.lateLaunchCleanupError = String(error);} save();
      }
    }, () => {});
    session = await step('browser-launch', () => launching, 90000); guardBrowserClose(session, profileDir);
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus'); assert.equal(report.windowPlacement.browserFrontmost, false);
    browserPid = await step('ownership-capture', () => getGuardedBrowserPid(session)); report.browserPid = browserPid;
    assert(!focusMonitor.events.some(event => event.pid === browserPid), 'Browser must not become foreground during launch');
    const context = session.context; context.setDefaultTimeout(15000);
    context.browser().on('disconnected', () => {if (!cleanupStarted && !ownedBrowserClosing) fail(new Error('Test browser disconnected before validation completed'));});
    async function checkFocus() {
      if (focusError) throw focusError;
      const front = await helper.queryMacFrontmostApplication();
      report.focusSamples.push({at: Date.now(), name: front?.name, pid: front?.pid});
      assert(front && front.pid !== browserPid, 'Test browser must remain in background');
      if (focusMonitor.error) throw focusMonitor.error;
    }
    await step('initial-focus-check', checkFocus);
    let checking = false;
    focusTimer = setInterval(() => {if (checking) return; checking = true; void checkFocus().catch(fail).finally(() => {checking = false;});}, 500);
    function observePage(page) {
      page.on('pageerror', error => {report.consoleErrors.push({surface: page.url(), kind: 'pageerror', message: error.message}); save();});
      page.on('console', message => {if (message.type() === 'error') {report.consoleErrors.push({surface: page.url(), kind: 'console', message: message.text()}); save();}});
    }
    context.on('page', observePage); context.pages().forEach(observePage);
    const worker = await step('extension-worker', async () => context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://')) || context.waitForEvent('serviceworker', {timeout: 30000}));
    await worker.evaluate(fixtureUrl => {
      const nativeFetch=globalThis.fetch.bind(globalThis);
      globalThis.fetch=(input,init)=>{
        const url=typeof input==='string'||input instanceof URL ? String(input) : input.url;
        return nativeFetch(url.startsWith('https://edge.microsoft.com/translate/translatetext') ? fixtureUrl : input, init);
      };
    },`http://127.0.0.1:${server.address().port}/translate`);
    worker.on('console', message => {if (message.type() === 'error') {report.consoleErrors.push({surface: 'worker', kind: 'console', message: message.text()}); save();}});
    const workerCDP = await step('worker-error-monitor', () => worker.evaluate(() => {
      globalThis.__pageNoticeUnhandledErrors = [];
      globalThis.addEventListener('unhandledrejection', event => globalThis.__pageNoticeUnhandledErrors.push(String(event.reason)));
      globalThis.addEventListener('error', event => globalThis.__pageNoticeUnhandledErrors.push(event.message));
      return true;
    })); report.workerErrorMonitor = workerCDP;
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    let bootstrap = context.pages().find(value => value.url().startsWith('about:blank#fluentread-background-'));
    async function open(url) {
      await checkFocus(); const page = bootstrap || await helper.newPageWithoutForeground(context, 30000); bootstrap = null;
      await page.goto(url, {timeout: 30000}); await checkFocus(); return page;
    }
    const control = await step('open-owned-options-control', () => open(`${origin}/${manifest.options_page || manifest.options_ui.page}`));
    const optionsControlTab = await step('options-control-tab-identity', () => control.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      return {id: tab?.id, windowId: tab?.windowId, url: location.href};
    }));
    assert(Number.isInteger(optionsControlTab?.id));
    report.optionsControlTab = optionsControlTab;
    const expectedOptionsUrl = new URL(`${origin}/${manifest.options_page || manifest.options_ui.page}`);
    const actualOptionsUrl = new URL(optionsControlTab.url);
    assert(actualOptionsUrl.protocol === expectedOptionsUrl.protocol && actualOptionsUrl.hostname === expectedOptionsUrl.hostname && actualOptionsUrl.pathname === expectedOptionsUrl.pathname);
    await step('configure-temporary-profile', () => patchStoredConfig(control, {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, theme: 'light', service: 'microsoft', to: 'zh-Hans', useCache: false, translationProgressPanelEnabled: true, disableFloatingBall: false, floatingBallToolsDisplay: 'hover', floatingBallClickAction: 'translate',
      informationHighlight: {enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, mode: 'keywords', model: 'qwen2.5-0.5b', density: 'medium', color: 'amber', style: 'background', intensity: 'standard'}}));
    const page = await step('open-owned-reading-page', () => open(fixtureUrl));
    await step('activate-owned-reading-tab', () => helper.activateExtensionTabWithoutForeground(context, page));
    const tabId = await step('owned-tab-id', () => control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, fixtureUrl)); assert(Number.isInteger(tabId));
    const send = (type, extra = {}) => step(`production-message:${type}`, () => control.evaluate(({tabId, type, extra}) => chrome.tabs.sendMessage(tabId, {type, ...extra}), {tabId, type, extra}));
    const ready = () => control.evaluate(async tabId => {
      for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
        try {const state = await chrome.tabs.sendMessage(tabId, {type: 'GET_INFORMATION_HIGHLIGHT_STATE'}); if (state) return state;} catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Production content message handler did not become ready');
    }, tabId);
    await step('production-content-ready', ready);
    const cdp = await context.newCDPSession(page);
    const worlds=[]; cdp.on('Runtime.executionContextCreated',event=>worlds.push(event.context)); cdp.on('Runtime.executionContextsCleared',()=>worlds.splice(0)); await cdp.send('Runtime.enable');
    const extensionWorld = () => worlds.find(value => value.origin?.includes(new URL(origin).host) && value.auxData?.type==='isolated') || worlds.find(value => value.name?.includes(new URL(origin).host));
    const inExtension = async expression => {const world=extensionWorld();assert(world,'Extension isolated world missing');const result=await cdp.send('Runtime.evaluate',{contextId:world.id,expression,returnByValue:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    // 触摸能力必须在生产组件的新文档挂载前生效，避免仅由动态媒体查询撑绿。
    await step('reload-with-touch-capability-before-mount', () => page.reload());
    await step('touch-capable-content-ready', ready);
    report.touchCapabilitySetup = {maxTouchPoints: 5, beforeFreshDocumentMount: true, nativeMobileEvidence: false}; save();
    const {findCdpNode, hasCdpClass} = require('../run-selection-trigger-test.cjs');
    async function inspect(selector, body) {
      const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
      const ball = findCdpNode(root, node => hasCdpClass(node, 'fr-floating-ball'));
      assert(ball, 'Production floating ball missing');
      const {object} = await cdp.send('DOM.resolveNode', {nodeId: ball.nodeId});
      try {
        const result = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId,
          functionDeclaration: `function(selector) { const el = selector ? this.querySelector(selector) : this; ${body} }`,
          arguments: [{value: selector}], returnByValue: true});
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
    }
    const metrics = () => inspect('', `
      const r = this.getBoundingClientRect();
      const main = this.querySelector('.floating-ball-main'), m = main.getBoundingClientRect();
      const css = getComputedStyle(main), shadow = this.getRootNode(), host = shadow instanceof ShadowRoot ? shadow.host : this;
      const visual = window.visualViewport;
      const left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
      const width = visual?.width ?? innerWidth, height = visual?.height ?? innerHeight;
      // 圆形按钮的命中点放在内侧，不把矩形包围盒的圆角空白当作故障。
      const samples = [['center', .5, .5], ['upper-left', .25, .25], ['upper-right', .75, .25], ['lower-left', .25, .75], ['lower-right', .75, .75]];
      const hitSamples = samples.map(([name, xRatio, yRatio]) => {
        const x = m.x + m.width * xRatio, y = m.y + m.height * yRatio;
        const rootHit = shadow.elementFromPoint(x, y), documentHit = main.ownerDocument.elementFromPoint(x, y);
        return {name, x, y, rootHitTarget: rootHit === main || main.contains(rootHit),
          documentHitOwn: documentHit === host || (!(shadow instanceof ShadowRoot) && host.contains(documentHit))};
      });
      return {dock:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},
        main:{x:m.x,y:m.y,width:m.width,height:m.height,right:m.right,bottom:m.bottom},
        position:this.dataset.position, status:this.dataset.translationStatus, style:main.getAttribute('style'),
        expanded:this.classList.contains('floating-ball-expanded'), viewport:{width:innerWidth,height:innerHeight},
        visualViewport:{left,top,width,height,right:left+width,bottom:top+height,scale:visual?.scale ?? 1},
        coarse:matchMedia('(pointer:coarse)').matches, anyPointerCoarse:matchMedia('(any-pointer:coarse)').matches,
        maxTouchPoints:navigator.maxTouchPoints ?? 0, hardwareTouchClass:this.classList.contains('is-touch-capable'),
        computedStyle:{display:css.display,visibility:css.visibility,opacity:css.opacity,pointerEvents:css.pointerEvents,
          transform:css.transform,transformIsIdentity:css.transform === 'none' || new DOMMatrixReadOnly(css.transform).isIdentity,clipPath:css.clipPath}, hitSamples};
    `);
    function assertMainTouchable(m, label, fixtureBounds) {
      // 几何、样式与命中均读取生产节点；可选边界只用于下方已明确标注的 VisualViewport fixture。
      const viewport = fixtureBounds || m.visualViewport, detail = JSON.stringify({label, fixtureBounds, metrics:m});
      assert(m.maxTouchPoints === 5 && m.hardwareTouchClass, detail);
      assert(m.main.width >= 43.9 && m.main.height >= 43.9, detail);
      assert(m.main.x >= viewport.left - .5 && m.main.right <= viewport.right + .5 && m.main.y >= viewport.top - .5 && m.main.bottom <= viewport.bottom + .5, detail);
      assert(m.computedStyle.display !== 'none' && m.computedStyle.visibility === 'visible' && m.computedStyle.pointerEvents === 'auto', detail);
      assert(Number(m.computedStyle.opacity) >= .699 && m.computedStyle.transformIsIdentity && m.computedStyle.clipPath === 'none', detail);
      assert(m.hitSamples.length === 5 && m.hitSamples.every(point => point.rootHitTarget && point.documentHitOwn), detail);
    }
    async function box(selector) {return inspect(selector, 'const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};');}
    async function tap(selector) {
      const r = await box(selector); const point = {x:r.x+r.width/2,y:r.y+r.height/2};
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await delay(250);
    }
    const record = (id, data={}) => {report.cases.push({id,status:'passed',...data}); save();};
    async function shot(name) {await checkFocus(); await page.screenshot({path:path.join(artifactsDir,`${name}.png`)}); report.screenshots.push(`${name}.png`); save();}
    await page.setViewportSize({width:390,height:844});
    await delay(600);
    let m = await metrics(); assert(m.coarse); assertMainTouchable(m, 'portrait-idle');
    record('touch-handle-full-44px',{metrics:m}); await shot('portrait-idle');
    await inspect('.floating-ball-main',`el.__events=[]; for(const name of ['pointerdown','pointerup','pointercancel','click']) el.addEventListener(name,event=>el.__events.push({type:event.type,pointerId:event.pointerId,button:event.button,detail:event.detail,trusted:event.isTrusted}));window.addEventListener('blur',()=>el.__events.push({type:'windowblur'}));return true;`);
    await tap('.floating-ball-main');
    report.firstTouch={metrics:await metrics(),events:await inspect('.floating-ball-main','return el.__events;')}; save();
    const progress = page.locator('.fr-translation-progress:not(.fr-compact)');
    await progress.waitFor({state:'visible'});
    await inExtension(`Object.defineProperty(window,'visualViewport',{configurable:true,value:Object.assign(new EventTarget(),{offsetLeft:15,offsetTop:140,width:360,height:320})});window.dispatchEvent(new Event('resize'));true`);
    await delay(400);
    const progressBounds=await progress.evaluate(el=>{const r=el.getBoundingClientRect(),b=el.querySelector('.fr-progress-dismiss').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,closeWidth:b.width,closeHeight:b.height};});
    report.progressBounds=progressBounds;save();
    assert(progressBounds.x>=15&&progressBounds.right<=375&&progressBounds.y>=140&&progressBounds.bottom<=460,JSON.stringify(progressBounds));assert(progressBounds.closeWidth>=43.9&&progressBounds.closeHeight>=43.9,JSON.stringify(progressBounds));
    record('progress-loading-visible-above-keyboard-fixture',{evidence:'production loading state, isolated-world keyboard geometry fixture',bounds:progressBounds});await shot('progress-keyboard-fixture');
    await tap('.floating-ball-main');
    await delay(2600);assert.equal(await page.locator('.fluent-read-bilingual-content').count(),0);assert.equal((await metrics()).status,'idle');record('cancel-loading-rejects-late-provider-response');
    await inExtension(`delete window.visualViewport;window.dispatchEvent(new Event('resize'));true`);
    translationDelayMs=0;await tap('.floating-ball-main');
    await page.locator('.fluent-read-bilingual-content').first().waitFor({state:'visible'});
    await step('full-page-translation-settles',async()=>{for(let i=0;i<100;i++){if((await metrics()).status==='translated')return;await delay(100);}throw new Error('Translation did not reach success');}); record('touch-full-page-translation',{count:await page.locator('.fluent-read-bilingual-content').count()}); await shot('portrait-translated');
    await tap('.floating-ball-main');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0);
    record('touch-restore-original');
    await tap('.floating-ball-main'); await page.locator('.fluent-read-bilingual-content').first().waitFor(); await step('retranslation-settles',async()=>{for(let i=0;i<100;i++){if((await metrics()).status==='translated')return;await delay(100);}throw new Error('Retranslation did not settle');}); record('touch-translate-again');
    // Drag uses trusted touch events, persists the proportional position, and must not toggle translation.
    const beforeStatus = (await metrics()).status, r = await box('.floating-ball-main');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+r.width/2,y:r.y+r.height/2}]});
    for(let i=1;i<=8;i++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:r.x+r.width/2+(45-r.x-r.width/2)*i/8,y:r.y+r.height/2+(620-r.y-r.height/2)*i/8}]});
    await delay(100); const dragging = await metrics(); assert(Math.abs(dragging.main.y+dragging.main.height/2-620)<3,JSON.stringify(dragging));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await delay(500);
    m=await metrics(); assert.equal(m.position,'left'); assert.equal(m.status,beforeStatus); assertMainTouchable(m, 'drag-completed'); record('drag-persists-without-translation-toggle',{metrics:m});
    await page.reload(); await step('content-ready-after-refresh', ready); await delay(600); m=await metrics(); assert.equal(m.position,'left'); assertMainTouchable(m, 'refresh-restores-dock'); record('refresh-restores-dock',{metrics:m});
    await page.setViewportSize({width:844,height:390}); await delay(400); m=await metrics(); assertMainTouchable(m, 'landscape-dock-visible'); record('landscape-dock-visible',{metrics:m}); await shot('landscape-dock');
    await page.setViewportSize({width:390,height:844});
    await patchStoredConfig(control,{floatingBallToolsDisplay:'always',theme:'dark'}); await delay(500);
    await tap('.floating-ball-settings');
    const popupFrame = page.frames().find(frame => frame.url().startsWith(`${origin}/popup.html`)); assert(popupFrame,'Embedded production popup missing');
    await popupFrame.locator('.popup-shell[data-config-ready="true"]').waitFor(); await delay(400);
    const popup = await inspect('', 'const frame = this.getRootNode().querySelector("iframe"); const r=frame.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,opacity:frame.style.opacity};');
    assert.equal(popup.opacity,'1'); assert(popup.x>=0 && popup.right<=390 && popup.y>=0 && popup.bottom<=844); record('touch-settings-popup-dark',{popup}); await shot('portrait-dark-settings');
    await page.keyboard.press('Escape'); await delay(200);
    // Deterministic VisualViewport injection is confined to the extension isolated world; it is a geometry fixture, not a phone keyboard test.
    await inExtension(`Object.defineProperty(window,'visualViewport',{configurable:true,value:Object.assign(new EventTarget(),{offsetLeft:25,offsetTop:180,width:340,height:300})});window.dispatchEvent(new Event('resize'));true`);
    await delay(250); m=await metrics(); assertMainTouchable(m, 'visual-viewport-keyboard-offset-fixture', {left:25,top:180,right:365,bottom:480}); record('visual-viewport-keyboard-offset-fixture',{evidence:'isolated-world viewport fixture; not actual keyboard',metrics:m}); await shot('keyboard-geometry-fixture');
    await patchStoredConfig(control,{disableFloatingBall:true}); await delay(300);
    const absent = await cdp.send('DOM.getDocument',{depth:-1,pierce:true}); assert(!findCdpNode(absent.root,node=>hasCdpClass(node,'fr-floating-ball'))); record('disable-unmounts-floating-controls');
    await patchStoredConfig(control,{disableFloatingBall:false}); await delay(400); m=await metrics(); assertMainTouchable(m, 'reenable-remounts-once', {left:25,top:180,right:365,bottom:480}); const mounted=await cdp.send('DOM.getDocument',{depth:-1,pierce:true}); let count=0; const walk=node=>{if(hasCdpClass(node,'fr-floating-ball'))count++;for(const child of [...(node.children||[]),...(node.shadowRoots||[])])walk(child);};walk(mounted.root);assert.equal(count,1);record('reenable-remounts-once',{count,metrics:m});
    await inspect('.floating-ball-main','el.click(); return true;'); await page.locator('.fluent-read-bilingual-content').first().waitFor(); record('click-only-activation-fixture',{evidence:'DOM click without pointer events; does not establish VoiceOver acceptance'});
    report.workerUnhandledErrors = await worker.evaluate(() => globalThis.__pageNoticeUnhandledErrors || []); assert.equal(report.workerUnhandledErrors.length,0);
    assert.equal(report.consoleErrors.length,0,JSON.stringify(report.consoleErrors)); await checkFocus(); report.ok=true;
  } catch (error) {
    primaryError ||= focusError || error; report.ok = false; report.error = primaryError.stack || String(primaryError); save();
    if (session && !focusError) for (const [index, page] of session.context.pages().entries()) {
      try {await page.screenshot({path: path.join(artifactsDir, `failure-${index}.png`), timeout: 5000}); report.screenshots.push(`failure-${index}.png`);} catch {}
    }
  } finally {
    cleanupStarted = true; clearInterval(focusTimer);
    if (session) try {await step('close-owned-browser', closeOwnedBrowser, 15000, true); report.browserCloseReceipt = 'shared-guard-fulfilled';}
    catch (error) {primaryError ||= error; report.cleanupError = String(error); report.ok = false;}
    if (focusMonitor) {
      report.focusEvents = [...focusMonitor.events];
      try {await step('stop-focus-observer', () => focusMonitor.stop(), 10000, true);} catch (error) {primaryError ||= error; report.focusObserverCleanupError = String(error); report.ok = false;}
    }
    if (server.listening) {server.closeAllConnections?.(); await step('close-fixture-server', () => new Promise(resolve => server.close(resolve)), 5000, true);}
    if (report.browserCloseReceipt === 'shared-guard-fulfilled' || !report.stages.some(value => value.name === 'browser-launch')) {fs.rmSync(profileDir, {recursive: true, force: true}); report.profileRemoved = true;}
    save();
  }
  console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, report: path.join(artifactsDir, 'report.json'), error: report.error || report.cleanupError}));
  if (primaryError || !report.ok) process.exitCode = 1;
})();
