'use strict';
/** 圈选生产回归：临时隔离 Edge，真实截图/OCR，确定性翻译边界；不读取用户密钥。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-area-flow'));
const playwrightRoot = arg('playwright-root');
const helper = arg('focus-safe-helper');
if (!playwrightRoot || !helper) throw new Error('必须提供 --playwright-root 和 --focus-safe-helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
// 保留真实标签可见性；Playwright 的默认焦点模拟会让非活动标签仍返回 visible。
const visibilityAwareChromium = {
  connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, {...options, noDefaults:true}),
  launchPersistentContext: (...options) => chromium.launchPersistentContext(...options),
};
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helper);
fs.mkdirSync(artifacts, {recursive: true});
const temporaryRoot = fs.realpathSync(os.tmpdir());
const profileDir = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-area-flow-'));
const profileIdentity = fs.lstatSync(profileDir);
const owner = crypto.randomUUID();
fs.writeFileSync(path.join(profileDir, '.owner'), owner, {flag: 'wx'});
const report = {scope: 'production extension, trusted screenshot gestures, real Tesseract, deterministic Google/OpenAI transports', cases: [], screenshots: [], errors: [], aiRequests: [], profileMode: 'automatically-created-temporary-profile'};
const javascriptFiles = [];
function collectJavaScript(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScript(file);
    else if (file.endsWith('.js')) javascriptFiles.push(file);
  }
}
collectJavaScript(extensionDir);
const javascriptHash = crypto.createHash('sha256');
for (const file of javascriptFiles.sort()) javascriptHash.update(path.relative(extensionDir, file)).update('\0').update(fs.readFileSync(file));
report.javascriptAssetsSha256 = javascriptHash.digest('hex');
const expectedSource = 'Welcome to FluentRead\nRead every word in your language\nKeep numbers 123 and names unchanged';
const translation = '欢迎使用流畅阅读\n用自己的语言读懂每一个字\n保留数字 123 和名称';
let aiMalformed = false;
const html = `<!doctype html><html><head><title>Area translation</title><style>
body{font:16px system-ui;margin:40px;background:#edf0f6;color:#202535}h1{font-size:24px}
#sample{display:block;margin-top:24px;width:740px;height:220px;background:white}
button{border:20px solid red;color:lime;background:black}p{line-height:3;color:red}
</style></head><body><h1>圈选翻译 · 真实截图与 OCR 验证</h1><div>OUTSIDE REGION SHOULD NEVER APPEAR</div><canvas id="sample" width="740" height="220"></canvas><input aria-label="输入测试"><div id="focus-container" tabindex="-1">FOCUSABLE CONTAINER</div><div style="height:1800px"></div>
<script>window.paint=(size=26,dark=false)=>{const c=document.querySelector('#sample');const x=c.getContext('2d');x.fillStyle=dark?'#172133':'#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle=dark?'#fff':'#172133';x.font=size+'px Arial';${JSON.stringify(expectedSource.split('\n'))}.forEach((t,i)=>x.fillText(t,24,50+i*60));};paint();</script></body></html>`;
const server = http.createServer((request, response) => {
  if (request.method === 'POST') {
    let body = '';
    request.on('data', chunk => {body += chunk;});
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        report.aiRequests.push(payload);
        assert.ok(!body.includes('data:image'), 'AI text enhancement must not upload screenshots');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 1, model: payload.model,
          choices: [{index: 0, message: {role: 'assistant', content: aiMalformed ? 'invalid structured response' : JSON.stringify({correctedText: expectedSource, translatedText: translation})}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 50, completion_tokens: 30, total_tokens: 80}}));
      } catch (error) {response.writeHead(500); response.end(error.message);}
    });
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
});
let launched, page, popup, worker, cdp, currentCase = 'launch';
let launchAttempted = false;
let sequence = 0;
async function patch(values) {
  await popup.evaluate(async ({values, sequence}) => {
    const {value: current} = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    for (const field of ['token', 'proxy', 'model', 'customModel']) if (values[field]) values[field] = {...current[field], ...values[field]};
    // 公开配置不包含凭据，不能将其当作 token 的 CAS 旧值；仅在本次临时 profile 初始化合成密钥时用 revision replace。
    const initialCredentials = Object.hasOwn(values, 'token');
    const response = await chrome.runtime.sendMessage({type: 'persistConfig', mode: initialCredentials ? 'replace' : 'patch', config: initialCredentials ? {...current, ...values} : values,
      expected: Object.fromEntries(Object.keys(values).map(k => [k, current[k]])), clientId: 'area-fixture', sequence, baseRevision: current.__fluentConfigRevision || 0});
    if (!response.success) throw new Error(response.error);
  }, {values, sequence: ++sequence});
}
async function ui(code) {
  const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
  let host;
  function visit(node) {
    const a = node.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'id' && a[i + 1] === 'fluent-read-area-translator-container') host = node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  }
  visit(tree.root);
  if (!host?.shadowRoots?.[0]) return null;
  const {object} = await cdp.send('DOM.resolveNode', {nodeId: host.shadowRoots[0].nodeId});
  try {
    const response = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: `function(){${code}}`, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
}
async function wait(test, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {if (await test()) return; await page.waitForTimeout(80);}
  throw new Error(`${currentCase}: ${await ui("return this.querySelector('.fr-area-translator-root')?.textContent")}`);
}
async function click(selector) {
  const point = await ui(`const n=this.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
  assert.ok(point, selector); await page.mouse.click(point.x, point.y);
}
async function clickText(text) {
  const disclosure = await ui(`const n=[...this.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});const d=n?.closest('details');if(!d||d.open)return null;const r=d.querySelector('summary').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
  if(disclosure) await page.mouse.click(disclosure.x,disclosure.y);
  const point = await ui(`const n=[...this.querySelectorAll('button,summary')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
  assert.ok(point, text); await page.mouse.click(point.x, point.y);
}
async function shot(name) {const target = path.join(artifacts, `${name}.png`); await page.screenshot({path: target}); report.screenshots.push(target);}
async function select() {
  await activateExtensionTabWithoutForeground(launched.context, page, 30000);
  // 用户先回到页面再圈选；也让响应式测试的 resize 布局和焦点恢复完成。
  await page.locator('h1').click();
  await page.keyboard.press('Shift+Z');
  await wait(() => ui("return !!this.querySelector('.fr-area-selecting')"));
  const r = await page.locator('#sample').boundingBox();
  await page.mouse.move(r.x, r.y); await page.mouse.down(); await page.mouse.move(r.x + r.width, r.y + r.height, {steps: 5}); await page.mouse.up();
}
async function waitResult() {await wait(async () => {
  const error = await ui("return this.querySelector('.fr-area-error-body')?.textContent");
  if (error) throw new Error(`${currentCase}: ${error}`);
  return ui("return !!this.querySelector('.fr-area-translation')");
}, 180000);}
async function sourceText() {return ui("return this.querySelector('.fr-area-source p[data-i18n-ignore]')?.textContent");}
function cer(actual, expected) {
  const a = actual.replace(/\s+/g, ' ').trim(), b = expected.replace(/\s+/g, ' ').trim();
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 0; i < a.length; i++) {const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1))); row = next;}
  return row[b.length] / b.length;
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium:visibilityAwareChromium, profileDir,
    browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: false, background: true,
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1280, height: 900}, timeout: 30000});
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground'); assert.equal(report.windowPlacement.browserFrontmost, false);
  const context = launched.context;
  worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
  popup = await newPageWithoutForeground(context, 30000);
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await patch({on: true, selectionAreaEnabled: true, disableImageTranslator: true, disableSelectionTranslator: true, from: 'en', to: 'zh-Hans', service: 'google', areaTranslationService: '', areaTranslationMode: 'standard', areaRecognitionMode: 'ocr'});
  await worker.evaluate(({translation}) => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.__areaFixture = {requests: [], endpointHosts: [], aborted: 0, delay: 300};
    globalThis.fetch = async (input, options) => {
      const url = String(typeof input === 'string' ? input : input.url || input);
      const hostname = new URL(url).hostname;
      const html = hostname === 'translate-pa.googleapis.com';
      const list = hostname === 'translate.googleapis.com';
      const rpc = url.includes('/_/TranslateWebserverUi/data/batchexecute');
      if (html || list || rpc) {
        const records = rpc ? JSON.parse(new URLSearchParams(options.body).get('f.req'))[0] : null;
        const origins = html ? JSON.parse(options.body)[0][0].map(text => text.replace(/^<pre>([\s\S]*)<\/pre>$/, '$1')
          .replace(/&(amp|lt|gt|quot|#39);/g, (_entity, code) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[code]))
          : list ? new URLSearchParams(options.body).getAll('q') : records.map(record => JSON.parse(record[1])[0][0]);
        assertPayload(origins);
        globalThis.__areaFixture.requests.push(...origins);
        globalThis.__areaFixture.endpointHosts.push(hostname);
        await new Promise((resolve, reject) => {
          const signal = options.signal;
          const abort = () => {globalThis.__areaFixture.aborted += 1; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError'));};
          const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); resolve();}, globalThis.__areaFixture.delay);
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
        });
        const texts = origins.map(() => translation);
        if (html) return new Response(JSON.stringify([texts]), {status:200});
        if (list) return new Response(JSON.stringify(texts), {status:200});
        return new Response(JSON.stringify(texts.map((text, index) => ['wrb.fr','MkEWBc',
          JSON.stringify([null,[[[null,null,null,null,null,[[text]]]]]]),null,null,null,records[index][3]])), {status:200});
      }
      if (/^translate(?:-pa)?\.google(?:apis)?\./.test(hostname)) throw new Error('Unexpected translation endpoint in deterministic area fixture');
      return original(input, options);
      function assertPayload(origins) {if (!origins.length || origins.some(origin => typeof origin !== 'string')) throw new Error('Unexpected Google area payload');}
    };
  }, {translation});
  const languageStart = Date.now();
  const downloaded = await popup.evaluate(() => chrome.runtime.sendMessage({type:'fluentReadImageOcrDownload',languages:['eng']}));
  assert.equal(downloaded.success, true, downloaded.error); report.languagePreparationMs = Date.now() - languageStart;
  page = await newPageWithoutForeground(context, 30000); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); cdp = await context.newCDPSession(page);
  await activateExtensionTabWithoutForeground(context, page, 30000);
  // 圈选 UI 按需挂载；先用可信快捷键唤起再退出，不能等待尚未触发的空宿主。
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+Z');
  await wait(() => ui("return !!this.querySelector('.fr-area-selecting')"));
  await page.keyboard.press('Escape');
  currentCase = 'synthetic shortcut ignored';
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Z',code:'KeyZ',shiftKey:true,bubbles:true})));
  assert.equal(await ui("return !!this.querySelector('.fr-area-selecting')"), false); report.cases.push(currentCase);
  currentCase = 'editable input keeps Shift+Z';
  await page.locator('input').focus(); await page.keyboard.press('Shift+Z');
  assert.equal(await ui("return !!this.querySelector('.fr-area-selecting')"), false); await page.locator('h1').click(); report.cases.push(currentCase);
  currentCase = 'focused non-editable container still triggers';
  await page.locator('#focus-container').focus();
  await page.keyboard.press('Shift+Z');
  await wait(() => ui("return !!this.querySelector('.fr-area-selecting')"));
  await page.keyboard.press('Escape'); await page.locator('h1').click(); report.cases.push(currentCase);
  currentCase = 'custom shortcut replaces the default one';
  await patch({selectionAreaHotkey: 'custom', customSelectionAreaHotkey: 'Alt+K'});
  // 保存响应先于内容页的异步配置订阅；先验证新快捷键生效，再断言旧键已停用。
  await wait(async () => {await page.keyboard.press('Alt+K'); return ui("return !!this.querySelector('.fr-area-selecting')");}, 10000);
  await page.keyboard.press('Escape');
  await wait(async () => (await ui("return !!this.querySelector('.fr-area-selecting')")) === false);
  await page.keyboard.press('Shift+Z');
  assert.equal(await ui("return !!this.querySelector('.fr-area-selecting')"), false, 'default shortcut must stop working');
  await page.keyboard.press('Alt+K');
  await wait(() => ui("return !!this.querySelector('.fr-area-selecting')"));
  await page.keyboard.press('Escape');
  await patch({selectionAreaHotkey: 'Shift+Z', customSelectionAreaHotkey: ''});
  await wait(async () => {await page.keyboard.press('Shift+Z'); return ui("return !!this.querySelector('.fr-area-selecting')");}, 10000);
  await page.keyboard.press('Escape');
  await page.locator('h1').click(); report.cases.push(currentCase);
  for (const mode of ['open', 'closed']) {
    currentCase = `${mode} shadow input keeps Shift+Z`;
    await page.evaluate(mode => {const host=document.createElement('div');host.id='shadow-input-fixture';document.body.prepend(host);const input=document.createElement('input');const root=host.attachShadow({mode});root.append(input);input.focus();}, mode);
    await page.keyboard.press('Shift+Z');
    assert.equal(await ui("return !!this.querySelector('.fr-area-selecting')"),false);
    await page.evaluate(()=>document.querySelector('#shadow-input-fixture').remove()); await page.locator('h1').click(); report.cases.push(currentCase);
  }
  await ui("this.__stages=[];const root=this;this.__stageObserver=new MutationObserver(()=>{const t=root.querySelector('.fr-area-loading span:nth-child(2)')?.textContent;if(t&&!root.__stages.includes(t))root.__stages.push(t);});this.__stageObserver.observe(this,{subtree:true,childList:true,characterData:true});return true;");
  currentCase = 'trusted selection and OCR'; const start = Date.now(); await select(); await waitResult(); report.firstSelectionMs = Date.now() - start; report.progress=await ui('return this.__stages'); assert.ok(report.progress.some(t=>t.includes('识别')));assert.ok(report.progress.some(t=>t.includes('翻译')));
  assert.equal(await page.evaluate(() => document.querySelector('#fluent-read-area-translator-container').shadowRoot), null);
  const source = await sourceText(); assert.match(source, /Welcome to FluentRead/); assert.match(source, /123/); assert.ok(!source.includes('OUTSIDE'));
  assert.equal(await ui("return this.querySelector('.fr-area-translation').textContent"), translation);
  assert.equal(await worker.evaluate(() => globalThis.__areaFixture.requests.length), 1, 'one complete text request');
  assert.equal((await ui("return this.querySelector('.fr-area-provider').textContent")).trim(), '谷歌翻译');
  assert.equal(await ui("return !!this.querySelector('.fr-area-model')"), false);
  report.cases.push('machine service name without model');
  report.ocrSamples = [{name: 'clear English 26px', source, cer: cer(source, expectedSource)}];
  assert.ok(report.ocrSamples[0].cer <= 0.03); report.cases.push(currentCase); await shot('01-standard-result');
  currentCase = 'same capture retry'; await page.evaluate(()=>{const c=document.querySelector('#sample'); const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='32px Arial';x.fillText('THIS IS A DIFFERENT SCREENSHOT',20,80);}); const retryStart = Date.now(); await clickText('重新翻译'); await waitResult(); report.retryMs = Date.now() - retryStart;
  assert.equal(await worker.evaluate(() => globalThis.__areaFixture.requests.length), 1); assert.equal(await sourceText(), source); await page.evaluate(()=>paint()); report.cases.push(currentCase);
  currentCase = 'source image and text review'; await clickText('识别原文'); await clickText('查看选区原图'); await shot('02-source-review');
  const geometry = await ui("const p=this.querySelector('.fr-area-panel'),r=p.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:p.scrollWidth>p.clientWidth};");
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height && !geometry.overflow); report.geometry = geometry;
  await ui("this.querySelector('.fr-area-content').scrollTop=500; return true;"); await page.waitForTimeout(120); assert.ok(await ui("return !!this.querySelector('.fr-area-translation')")); report.cases.push(currentCase);
  currentCase = 'escape clears result and next selection works'; await page.keyboard.press('Escape'); assert.equal(await ui("return !!this.querySelector('.fr-area-panel')"), false); await select(); await waitResult(); report.cases.push(currentCase);
  for (const [name,size,dark] of [['small English 14px',14,false],['dark English 20px',20,true]]) {
    currentCase = name; await page.keyboard.press('Escape'); await page.evaluate(({size,dark})=>paint(size,dark),{size,dark}); await select(); await waitResult();
    const text=await sourceText(); const sample={name,source:text,cer:cer(text,expectedSource)}; report.ocrSamples.push(sample); assert.ok(sample.cer <= 0.1, `${name}: ${text}`); await shot(`ocr-${size}-${dark}`); report.cases.push(name);
  }
  currentCase = 'AI structured entire-region translation';
  await patch({areaTranslationMode:'ai',areaTranslationService:'openai',model:{openai:'gpt-4.1-mini'},token:{openai:'fixture-not-a-real-key'},proxy:{openai:`http://127.0.0.1:${server.address().port}/v1/chat/completions`}});
  await page.keyboard.press('Escape'); await page.evaluate(()=>paint()); await select(); await waitResult();
  assert.equal(report.aiRequests.length,1); assert.ok(JSON.stringify(report.aiRequests[0]).includes('Welcome to FluentRead'));
  assert.ok(JSON.stringify(report.aiRequests[0]).includes('correctedText')); assert.equal(await ui("return this.querySelector('.fr-area-mode').textContent"),'本地 OCR · AI 文本增强'); report.cases.push(currentCase); await shot('03-ai-result');
  assert.match(await ui("return this.querySelector('.fr-area-provider').textContent"), /OpenAI.*gpt-4\.1-mini/s);
  currentCase = 'result metadata stays frozen until retry';
  await patch({model:{openai:'gpt-4.1-nano'}});
  assert.match(await ui("return this.querySelector('.fr-area-provider').textContent"), /gpt-4\.1-mini/);
  await clickText('重新翻译'); await waitResult();
  assert.match(await ui("return this.querySelector('.fr-area-provider').textContent"), /gpt-4\.1-nano/);
  assert.equal(report.aiRequests.at(-1).model,'gpt-4.1-nano'); report.cases.push(currentCase);
  currentCase = 'invalid AI response exposes retry, no silent fallback'; aiMalformed=true; await clickText('重新翻译');
  await wait(()=>ui("return !!this.querySelector('.fr-area-error-body')")); assert.equal(await ui("return !!this.querySelector('.fr-area-provider')"),false); assert.equal(await ui("return !!this.querySelector('.fr-area-translation')"),false); await shot('04-ai-retry-error');
  aiMalformed=false; await clickText('重试'); await waitResult(); report.cases.push(currentCase);
  currentCase = 'close cancels pending and no late result'; await worker.evaluate(()=>{globalThis.__areaFixture.delay=1500;});
  await patch({areaTranslationMode:'standard',areaTranslationService:'google',to:'ja'}); const beforeCancel=await worker.evaluate(()=>globalThis.__areaFixture.requests.length); await clickText('重新翻译'); await wait(async()=>await worker.evaluate(()=>globalThis.__areaFixture.requests.length)>beforeCancel); await clickText('取消'); await page.waitForTimeout(1800); assert.ok(await worker.evaluate(()=>globalThis.__areaFixture.aborted)>0);
  assert.equal(await ui("return !!this.querySelector('.fr-area-panel')"),false); report.cases.push(currentCase);
  currentCase = 'post-cancel retry'; await worker.evaluate(()=>{globalThis.__areaFixture.delay=50;}); await select(); await waitResult();
  report.cases.push(currentCase);
  currentCase='switching tabs cancels the old operation';
  assert.equal(await page.evaluate(()=>document.visibilityState),'visible');
  const popupTab=await popup.evaluate(()=>chrome.tabs.getCurrent());
  report.tabSetup=await worker.evaluate(async ({pageUrl,popupTab})=>{const tabs=await chrome.tabs.query({});const selected=tabs.find(t=>t.url===pageUrl||t.pendingUrl===pageUrl);if(!selected)throw new Error('找不到圈选测试标签');if(selected.windowId!==popupTab.windowId)await chrome.tabs.move(popupTab.id,{windowId:selected.windowId,index:-1});return {selectedTabId:selected.id,windowId:selected.windowId,popupTabId:popupTab.id};},{pageUrl:page.url(),popupTab});
  await patch({to:'ko'}); await worker.evaluate(()=>{globalThis.__areaFixture.delay=3000;});
  const beforeSwitch=await worker.evaluate(()=>({requests:globalThis.__areaFixture.requests.length,aborted:globalThis.__areaFixture.aborted}));
  await clickText('重新翻译'); await wait(async()=>await worker.evaluate(()=>globalThis.__areaFixture.requests.length)>beforeSwitch.requests);
  await activateExtensionTabWithoutForeground(context,popup,30000); report.tabSwitchState={visibility:await page.evaluate(()=>document.visibilityState),tabs:await worker.evaluate(()=>chrome.tabs.query({}).then(tabs=>tabs.map(({active,url,windowId})=>({active,url,windowId}))))}; assert.equal(report.tabSwitchState.visibility,'hidden'); await page.waitForTimeout(3200);
  assert.equal(await ui("return !!this.querySelector('.fr-area-panel')"),false);assert.ok(await worker.evaluate(()=>globalThis.__areaFixture.aborted)>beforeSwitch.aborted);
  await worker.evaluate(()=>{globalThis.__areaFixture.delay=50;});await select();await waitResult();report.cases.push(currentCase);
  currentCase='captured result survives page scroll'; await page.evaluate(()=>scrollTo(0,100)); await page.waitForTimeout(200); assert.ok(await ui("return !!this.querySelector('.fr-area-panel')")); await page.evaluate(()=>scrollTo(0,0)); report.cases.push(currentCase);
  currentCase='narrow dark result geometry'; await patch({theme:'dark'}); await wait(()=>ui("return this.querySelector('.fr-area-translator-root')?.classList.contains('fr-area-dark')")); await page.setViewportSize({width:390,height:780}); await page.evaluate(()=>{document.body.style.margin='16px';const c=document.querySelector('#sample');c.width=350;c.style.width='350px';paint(18,true);}); await select(); await waitResult();
  report.darkColors=await ui("const p=this.querySelector('.fr-area-panel');return {background:getComputedStyle(p).backgroundColor,text:getComputedStyle(p).color,overlay:getComputedStyle(this.querySelector('.fr-area-translator-root')).backgroundColor};"); assert.equal(report.darkColors.background,'rgb(43, 38, 48)'); assert.equal(report.darkColors.overlay,'rgba(0, 0, 0, 0)');
  const narrow=await ui("const p=this.querySelector('.fr-area-panel'),r=p.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:p.scrollWidth>p.clientWidth};"); assert.ok(narrow.left>=0&&narrow.right<=narrow.width&&narrow.bottom<=narrow.height&&!narrow.overflow); report.narrowGeometry=narrow; await shot('05-dark-narrow'); report.cases.push(currentCase);
  currentCase='long model wraps in narrow dark panel';
  const longModel='organization/'+ 'translation-model-'.repeat(8);
  await patch({areaTranslationService:'openai',model:{openai:'自定义模型'},customModel:{openai:longModel}}); await clickText('重新翻译'); await waitResult();
  assert.ok((await ui("return this.querySelector('.fr-area-provider').textContent")).includes(longModel));
  assert.equal(await ui("const p=this.querySelector('.fr-area-provider'); return p.scrollWidth>p.clientWidth;"),false);
  assert.ok(await ui("const p=this.querySelector('.fr-area-panel').getBoundingClientRect(),b=this.querySelector('.fr-area-toolbar button').getBoundingClientRect(); return b.right<=p.right&&b.left>=p.left;"));
  await shot('06-long-model-dark'); report.cases.push(currentCase);
  await patch({areaTranslationService:'google'});
  currentCase='live motion settings retain static progress'; await patch({to:'fr'}); await worker.evaluate(()=>{globalThis.__areaFixture.delay=20000;}); await clickText('重新翻译'); await wait(()=>ui("return !!this.querySelector('.fr-area-loading')"));
  assert.equal(await ui("return !!this.querySelector('.fr-area-provider')"),false);
  await patch({animations:false}); await wait(()=>ui("return !!this.querySelector('.fr-area-spinner.fr-area-static')")); assert.equal(await ui("return getComputedStyle(this.querySelector('.fr-area-spinner')).animationName"),'none'); assert.ok(await ui("return this.querySelector('.fr-area-loading').textContent.includes('正在')"));
  await patch({animations:true}); await wait(()=>ui("return this.querySelector('.fr-area-spinner')&&!this.querySelector('.fr-area-spinner.fr-area-static')")); await clickText('取消'); report.cases.push(currentCase);
  currentCase='disabled cleanup'; await patch({selectionAreaEnabled:false}); await wait(async()=>!(await page.locator('#fluent-read-area-translator-container').count())); report.cases.push(currentCase);
  report.googleEndpointHosts = await worker.evaluate(() => globalThis.__areaFixture.endpointHosts);
  assert.deepEqual(report.errors,[]); report.success=true;
})().catch(async error=>{report.success=false;report.failure={case:currentCase,message:error.stack};process.exitCode=1;if(page)await shot('failure').catch(()=>{});}).finally(async()=>{
  let closed = !launchAttempted;
  try{if(launched){await launched.close();closed=true;}}catch(error){report.cleanupError=error.message;process.exitCode=1;}
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  if(closed){const stat=fs.lstatSync(profileDir);assert.ok(!stat.isSymbolicLink()&&stat.ino===profileIdentity.ino&&stat.dev===profileIdentity.dev);assert.equal(fs.readFileSync(path.join(profileDir,'.owner'),'utf8'),owner);fs.rmSync(profileDir,{recursive:true});report.profileRemoved=true;}
  else report.retainedProfile = profileDir;
  // 本地假密钥不需要保留；只报告模型、文本和结构，所有网络请求均为夹具。
  fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
});
