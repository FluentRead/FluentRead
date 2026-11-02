'use strict';
/** 圈选视觉生产回归：真实截图和设置、仅本机模拟视觉模型；不读取用户密钥。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-area-vision'));
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
const profileDir = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-area-vision-'));
const profileIdentity = fs.lstatSync(profileDir);
const owner = crypto.randomUUID();
fs.writeFileSync(path.join(profileDir, '.owner'), owner, {flag: 'wx'});
const report = {extensionDir, scope: 'production extension, real screenshot/crop/UI, local HTTP mock vision and translation; no external model-quality proof', cases: [], screenshots: [], errors: [], requests: [], profileMode: 'automatically-created-temporary-profile'};
const expectedSource = 'Welcome to FluentRead\nRead every word in your language\nKeep numbers 123 and names unchanged';
const translation = '欢迎使用流畅阅读\n用自己的语言读懂每一个字\n保留数字 123 和名称';
let visionFailure = false, visionDelay = 0;
let lastCropHash = '';
const sharp = require(path.join(playwrightRoot, 'sharp'));
const html = `<!doctype html><html><head><title>Area translation</title><style>
body{font:16px system-ui;margin:40px;background:#edf0f6;color:#202535}h1{font-size:24px}
#sample{display:block;margin-top:24px;width:740px;height:220px;background:white}
button{border:20px solid red;color:lime;background:black}p{line-height:3;color:red}
</style></head><body><h1>圈选翻译 · 真实截图与 OCR 验证</h1><div>OUTSIDE REGION SHOULD NEVER APPEAR</div><canvas id="sample" width="740" height="220"></canvas><input aria-label="输入测试"><div style="height:1800px"></div>
<script>window.paint=(size=26,dark=false)=>{const c=document.querySelector('#sample');const x=c.getContext('2d');x.fillStyle=dark?'#172133':'#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle=dark?'#fff':'#172133';x.font=size+'px Arial';${JSON.stringify(expectedSource.split('\n'))}.forEach((t,i)=>x.fillText(t,24,50+i*60));};paint();</script></body></html>`;
const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return;}
  let body = '';
  request.on('data', chunk => {body += chunk;});
  request.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const content = payload.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
      const image = content.find(p => p.type === 'image_url')?.image_url.url;
      const text = payload.messages.map(m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')).join('\n');
      let dimensions, hash, probe = false;
      if (image) {
        assert.match(image, /^data:image\/png;base64,/);
        const buffer = Buffer.from(image.split(',')[1], 'base64');
        const meta = await sharp(buffer).metadata();
        dimensions = {width: meta.width, height: meta.height};
        probe = payload.model === 'unconfirmed-model' && text.includes('Read the six hexadecimal characters visible in the image');
        if (probe) {
          assert.deepEqual(dimensions, {width:224,height:64});
          assert.ok(!text.includes(expectedSource), 'probe must not contain the captured page text');
        } else {
          report.lastReceivedImageDimensions=dimensions;
          // Crop edges round outwards at fractional device pixels; allow at most one extra pixel per edge.
          assert.ok(Math.abs(meta.width - report.expectedCropPixels.width) <= 2 && Math.abs(meta.height - report.expectedCropPixels.height) <= 2, 'only selected crop uploaded');
        }
        hash = crypto.createHash('sha256').update(buffer).digest('hex'); if (!probe) lastCropHash = hash;
      }
      report.requests.push({model: payload.model, vision: Boolean(image), probe, dimensions, hash, prompt: text});
      if (image && !probe && visionDelay) await new Promise(resolve => setTimeout(resolve, visionDelay));
      if (image && !probe && visionFailure) {response.writeHead(401, {'content-type': 'application/json'});response.end(JSON.stringify({error:{message:'fixture auth failure'}}));return;}
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:payload.model,choices:[{index:0,message:{role:'assistant',content:probe?'UNKNOWN':image?expectedSource:translation},finish_reason:'stop'}],usage:{prompt_tokens:50,completion_tokens:30,total_tokens:80}}));
    } catch (error) {report.mockServerError=error.message;response.writeHead(500);response.end(error.message);}
  });
});
let settings;
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
  const scale = await page.evaluate(() => devicePixelRatio);
  report.expectedCropPixels = {width:r.width*scale,height:r.height*scale};
  await page.mouse.move(r.x, r.y); await page.mouse.down(); await page.mouse.move(r.x + r.width, r.y + r.height, {steps: 5}); await page.mouse.up();
}
async function waitResult() {await wait(async () => {
  const error = await ui("return this.querySelector('.fr-area-error-body')?.textContent");
  if (error) throw new Error(`${currentCase}: ${error}`);
  return ui("return !!this.querySelector('.fr-area-translation')");
}, 180000);}
async function sourceText() {return ui("return this.querySelector('.fr-area-source p[data-i18n-ignore]')?.textContent");}

(async () => {
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium:visibilityAwareChromium,profileDir,
    browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,
    browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check'],viewport:{width:1280,height:900},timeout:30000});
  Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
  assert.equal(report.launchMode,'macos-background-cdp');assert.equal(report.focusPolicy,'launchservices-no-foreground');assert.equal(report.windowPlacement.browserFrontmost,false);
  const context=launched.context;
  worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))||await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).host}`;
  popup=await newPageWithoutForeground(context,30000);await popup.goto(`${origin}/popup.html`);
  await patch({on:true,selectionAreaEnabled:true,disableImageTranslator:true,disableSelectionTranslator:true,from:'en',to:'zh-Hans',uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,service:'openai',areaTranslationService:'',areaTranslationMode:'standard',model:{openai:'gpt-4.1-mini'},token:{openai:'fixture-not-real'},proxy:{openai:`http://127.0.0.1:${server.address().port}/v1/chat/completions`},translationMaxRetries:0});
  async function openSettings() {
    settings=await newPageWithoutForeground(context,30000);settings.on('pageerror',e=>report.errors.push(e.message));
    await settings.goto(`${origin}/options.html#settings-area-translation`);
    await activateExtensionTabWithoutForeground(context,settings,30000);
    const details=settings.locator('details.area-translation-details');
    await details.waitFor({state:'visible'});
    if(await details.getAttribute('open')===null) await details.locator(':scope > summary').click();
    await settings.getByTestId('area-recognition-mode').waitFor();
  }
  currentCase='recognition and prompt settings persist after quick close';await openSettings();
  const recognition=settings.getByTestId('area-recognition-mode');
  await recognition.click();await settings.getByRole('option').filter({hasText:'优先使用模型识图'}).click();
  await settings.getByRole('button',{name:'编辑识图提示词'}).click();
  const prompt=settings.getByRole('textbox',{name:'模型识图提示词'});
  await prompt.fill('忠实识别图中文字，保留每行顺序。\n保留名称和数字，不要补写模糊的文字。');
  await settings.close();await openSettings();
  await settings.getByRole('button',{name:'编辑识图提示词'}).click();
  assert.equal(await settings.getByRole('textbox',{name:'模型识图提示词'}).inputValue(),'忠实识别图中文字，保留每行顺序。\n保留名称和数字，不要补写模糊的文字。');
  await settings.screenshot({animations:'disabled',path:path.join(artifacts,'01-prompt-editor.png')});report.screenshots.push(path.join(artifacts,'01-prompt-editor.png'));
  await settings.getByRole('button',{name:'完成',exact:true}).click();
  await settings.getByRole('textbox',{name:'模型识图提示词'}).waitFor({state:'hidden'});
  assert.match(await settings.locator('body').innerText(),/模型|识图/);
  await settings.screenshot({animations:'disabled',path:path.join(artifacts,'01-settings-persisted.png')});report.screenshots.push(path.join(artifacts,'01-settings-persisted.png'));report.cases.push(currentCase);
  const saved=await popup.evaluate(async()=> (await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value);
  assert.equal(saved.areaRecognitionMode,'prefer-vision');assert.ok(saved.areaVisionPrompt.includes('保留名称和数字，不要补写模糊的文字。'));
  await patch({theme:'dark'});await settings.setViewportSize({width:820,height:900});
  assert.equal(await settings.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await settings.screenshot({animations:'disabled',path:path.join(artifacts,'02-settings-dark-narrow.png')});report.screenshots.push(path.join(artifacts,'02-settings-dark-narrow.png'));
  await patch({theme:'light'});
  currentCase='model capability control saves per model';
  async function openModelSettings() {
    await settings.goto(`${origin}/options.html#settings-services`);
    await settings.locator('.service-catalog').waitFor({state:'visible'});
    const directoryToggle=settings.locator('.mobile-directory-toggle');
    if(await directoryToggle.isVisible() && await directoryToggle.getAttribute('aria-expanded')!=='true') await directoryToggle.click();
    await settings.locator('[data-service-value="openai"]').click();
    await settings.locator('[id$="tab-translation"]').click();
    const translationGroup=settings.locator('[data-configuration-group="translation"]');
    await translationGroup.getByTestId('model-vision-capability').waitFor();
  }
  await openModelSettings();
  await settings.getByTestId('model-vision-capability').getByRole('radio',{name:'支持识图',exact:true}).click();
  await settings.close();await openSettings();await openModelSettings();
  assert.equal(await settings.getByTestId('model-vision-capability').getByRole('radio',{name:'支持识图',exact:true}).getAttribute('aria-checked'),'true');
  await settings.getByTestId('model-vision-capability').scrollIntoViewIfNeeded();
  await settings.screenshot({animations:'disabled',path:path.join(artifacts,'03-model-capability.png')});report.screenshots.push(path.join(artifacts,'03-model-capability.png'));
  await settings.getByTestId('model-vision-capability').getByRole('radio',{name:'自动判断',exact:true}).click();
  await settings.close();report.cases.push(currentCase);
  page=await newPageWithoutForeground(context,30000);page.on('pageerror',e=>report.errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);cdp=await context.newCDPSession(page);
  await activateExtensionTabWithoutForeground(context,page,30000);
  // 圈选宿主按需挂载；通过可信快捷键唤起后退出，再进入截图用例。
  await page.waitForTimeout(500);await page.locator('h1').click();await page.keyboard.press('Shift+Z');
  await wait(()=>ui("return !!this.querySelector('.fr-area-selecting')"));
  await page.keyboard.press('Escape');
  currentCase='vision succeeds without OCR packs and uploads only crop';await select();await waitResult();
  assert.equal(await sourceText(),expectedSource);assert.equal(await ui("return this.querySelector('.fr-area-translation').textContent"),translation);
  assert.match(await ui("return this.querySelector('.fr-area-mode').textContent"),/模型识图/);
  assert.equal(report.requests.filter(r=>r.vision).length,1);assert.equal(report.requests.length,2);
  assert.ok(report.requests[0].prompt.includes('保留名称和数字，不要补写模糊的文字。'));assert.ok(!report.requests[0].prompt.includes('OUTSIDE REGION'));
  await shot('03-vision-result');report.cases.push(currentCase);
  currentCase='same captured crop retranslated without image cache';const previousHash=lastCropHash;
  await page.evaluate(()=>{const c=document.querySelector('#sample');c.getContext('2d').clearRect(0,0,c.width,c.height);});await clickText('重新翻译');await waitResult();
  assert.equal(report.requests.filter(r=>r.vision).length,2);assert.equal(lastCropHash,previousHash);report.cases.push(currentCase);
  currentCase='known unsupported and probed-unknown model use local OCR';
  for(const model of ['gpt-3.5-turbo','unconfirmed-model']) {
    await patch({model:{openai:'自定义模型'},customModel:{openai:model},modelVision:{openai:{'gpt-3.5-turbo':false}}});const count=report.requests.length;await clickText(model==='gpt-3.5-turbo'?'重新翻译':'重试');await wait(()=>ui("return !!this.querySelector('.fr-area-error-body')"));
    assert.ok(await ui("return [...this.querySelectorAll('button')].some(n=>n.textContent.includes('下载语言包并重试'))"));
    assert.equal(report.requests.length,count+(model==='unconfirmed-model'?1:0));
    if(model==='unconfirmed-model') assert.equal(report.requests.at(-1).probe,true);
  }
  report.cases.push(currentCase);
  currentCase='explicit model capability override reaches vision';await patch({modelVision:{openai:{'unconfirmed-model':true}}});
  report.overrideConfig=await popup.evaluate(async()=>{const {value:c}=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});return {model:c.model.openai,customModel:c.customModel.openai,vision:c.modelVision,mode:c.areaRecognitionMode};});
  await clickText('重试');await waitResult();
  assert.equal(report.requests.filter(r=>r.vision).at(-1).model,'unconfirmed-model');report.cases.push(currentCase);
  currentCase='provider error does not fall back to OCR';visionFailure=true;await clickText('重新翻译');await wait(()=>ui("return !!this.querySelector('.fr-area-error-body')"));
  assert.equal(await ui("return [...this.querySelectorAll('button')].some(n=>n.textContent.includes('下载语言包并重试'))"),false);await shot('04-provider-error');visionFailure=false;await clickText('重试');await waitResult();report.cases.push(currentCase);
  currentCase='cancel image request ignores late response and allows retry';visionDelay=1200;const count=report.requests.length;await clickText('重新翻译');await wait(()=>report.requests.length>count);await clickText('取消');await page.waitForTimeout(1500);
  assert.equal(await ui("return !!this.querySelector('.fr-area-panel')"),false);visionDelay=0;await page.evaluate(()=>paint());await select();await waitResult();report.cases.push(currentCase);
  currentCase='unmount on disabling feature';await patch({selectionAreaEnabled:false});await wait(async()=>!(await page.locator('#fluent-read-area-translator-container').count()));report.cases.push(currentCase);
  assert.deepEqual(report.errors,[]);report.success=true;
})().catch(async error=>{report.success=false;report.failure={case:currentCase,message:error.stack};process.exitCode=1;if(page)await shot('failure').catch(()=>{});if(settings&&!settings.isClosed()){await settings.screenshot({animations:'disabled',path:path.join(artifacts,'settings-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'settings-failure.html'),await settings.content().catch(()=>''));}}).finally(async()=>{
  let closed=!launchAttempted;
  try{if(launched){await launched.close();closed=true;}}catch(error){report.cleanupError=error.message;process.exitCode=1;}
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  if(closed){const stat=fs.lstatSync(profileDir);assert.ok(!stat.isSymbolicLink()&&stat.ino===profileIdentity.ino&&stat.dev===profileIdentity.dev);assert.equal(fs.readFileSync(path.join(profileDir,'.owner'),'utf8'),owner);fs.rmSync(profileDir,{recursive:true});report.profileRemoved=true;}
  else report.retainedProfile=profileDir;
  fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
});
