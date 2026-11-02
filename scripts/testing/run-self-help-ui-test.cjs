#!/usr/bin/env node
/** 首次使用与自助诊断专项：生产扩展、临时 profile、本地 HTTP 夹具；--live-default true 显式增加默认免费池在线烟测，不复用日常浏览器。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require('./focus-safe-browser.cjs');
const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, i, list) => i % 2 ? all : [...all, [value.replace(/^--/, ''), list[i + 1]]], []));
const extension = path.resolve(args.extension || '.output/chrome-mv3');
const out = path.resolve(args.artifacts || '/private/tmp/fluentread-self-help-ui');
fs.mkdirSync(out, {recursive: true});
if (!args['playwright-root']) throw new Error('Pass --playwright-root from load_workspace_dependencies.');
const runtimeRequire = createRequire(path.join(path.resolve(args['playwright-root']), 'loader.cjs'));
const {chromium} = runtimeRequire('playwright');
const result = {production: true, cases: [], screenshots: [], consoleErrors: [], providerValidation: args['live-default'] === 'true' ? 'Local HTTP fixtures plus one live default-free smoke with public synthetic text.' : 'Local HTTP fixtures only.', limitations: ['No Firefox, Safari, physical device or long-term cross-region provider acceptance.']};
let mode = 'success', session, server, sequence = 0, launchAttempted = false;
const requests = [];
const closedPending = [];
result.requests = requests;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-self-help-'));
const body = '<!doctype html><html lang="en"><head><title>Reading test</title></head><body><article><h1>A quiet place to read</h1><p>Reading across languages helps us understand each other. This paragraph is deliberately long enough to be selected as real article content for the first translation.</p><p>A useful translation tool keeps the original text available and lets people recover when a service is temporarily unavailable.</p></article></body></html>';
async function shot(page, name) {await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForTimeout(250);const label = await page.locator('.translate-label').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {text:el.textContent,width:r.width,height:r.height,color:s.color,visibility:s.visibility,opacity:s.opacity};}));(result.labelMetrics ||= {})[name]=label;const file = path.join(out, name + '.png');await page.screenshot({path: file});result.screenshots.push(file);}
function record(name) {result.cases.push(name);}
async function pollValue(read, accepts, label, timeout=30000) {
 const until=Date.now()+timeout;
 do {const value=await read();if(accepts(value))return value;await new Promise(resolve=>setTimeout(resolve,50));} while(Date.now()<until);
 throw new Error('Timed out waiting for '+label);
}
async function readTranslationStatus(page, tabId) {
 return page.evaluate(async id=>{
  try {const state=await chrome.tabs.sendMessage(id,{type:'getFullPageTranslationState'},{frameId:0});return {status:state?.toolbarStatus,code:state?.diagnostic?.code};}
  catch {return undefined;}
 },tabId);
}
async function waitForCompletedTranslation(page, tabId, timeout=30000) {
 const status=await pollValue(()=>readTranslationStatus(page,tabId),value=>value?.status==='translated','the completed page translation',timeout);
 await page.locator('[data-testid="page-translation"][aria-pressed="true"][aria-busy="false"]').waitFor({timeout});
 return status;
}
async function fitNativePopup(page) {
 const width=await page.evaluate(()=>Math.ceil(parseFloat(getComputedStyle(document.documentElement).width)));
 assert.ok(width>=300&&width<=420,'Use the production popup intrinsic width');await page.setViewportSize({width,height:600});
 const bounds=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,root:document.documentElement.clientWidth,body:document.body.getBoundingClientRect().width,right:Math.max(...['.popup-header','.hero-card','.fluentread-diagnostic'].flatMap(selector=>[...document.querySelectorAll(selector)].map(el=>el.getBoundingClientRect().right)))}));
 assert.ok(bounds.scrollWidth<=bounds.viewport&&bounds.body<=bounds.viewport&&bounds.right<=bounds.viewport);return bounds;
}
function diagnosticNotice(page, code) {
 return page.locator(code ? `[data-diagnostic-code="${code}"]` : '[data-diagnostic-code]');
}
async function assertCollapsedDiagnostic(page, code, label) {
 const notice=diagnosticNotice(page,code);await notice.waitFor();
 const trigger=notice.locator('[data-diagnostic-details-toggle]');
 assert.equal(await trigger.getAttribute('aria-expanded'),'false','Status popover starts closed');
 for(const selector of ['[data-diagnostic-details]','.diagnostic-actions','.diagnostic-report','[data-diagnostic-primary]','[data-diagnostic-preview]','[data-diagnostic-dismiss]'])assert.equal(await notice.locator(selector).count(),0,'Closed status must not mount '+selector);
 assert.equal(await notice.locator('button').count(),1,'Default diagnosis exposes only one status trigger');
 const metrics=await trigger.evaluate(el=>{const rect=el.getBoundingClientRect();return {height:rect.height,width:rect.width,label:el.getAttribute('aria-label'),right:rect.right,viewport:innerWidth};});
 assert.ok(metrics.label,'The status trigger must have a localized accessible reason');
 assert.ok(metrics.height>0&&metrics.height<=24&&metrics.width<=28,'Default diagnosis must be a small icon: '+JSON.stringify(metrics));
 assert.ok(metrics.right<=metrics.viewport,'Status trigger stays inside popup');
 (result.collapsedDiagnosticLayouts ||= {})[label]=metrics;return notice;
}
async function openDiagnosticDetails(page, code) {
 const notice=diagnosticNotice(page,code),toggle=notice.locator('[data-diagnostic-details-toggle]');
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 await notice.locator('[data-diagnostic-details][role="dialog"]').waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'true');return notice;
}
async function activateDiagnosticAction(page, action, code) {
 const notice=await openDiagnosticDetails(page,code),button=notice.locator(`[data-diagnostic-action="${action}"]`);
 assert.equal(await button.count(),1,'Exactly one actual diagnosis action for '+action);assert.equal(await button.isEnabled(),true,'Diagnosis action must be enabled');
 try {await button.click();} catch(error) {if(action!=='services'||!page.isClosed())throw error;}
}
async function previewDiagnostic(page, code) {
 const notice=await openDiagnosticDetails(page,code);await notice.locator('[data-diagnostic-preview]').click();await notice.locator('.diagnostic-report pre').waitFor();return notice;
}
(async () => {
 try {
  server = http.createServer((req, res) => {
   if (req.url === '/empty') {res.writeHead(200, {'Content-Type': 'text/html'});res.end('<!doctype html><html><body></body></html>');return;}
   if (req.method !== 'POST') {res.writeHead(200, {'Content-Type': 'text/html'});res.end(body.replaceAll('<p>', '<p>' + mode + ' scenario. '));return;}
   requests.push({mode, path:req.url});
   if (mode === 'timeout' || mode === 'hold') {const pendingMode=mode;res.on('close',()=>closedPending.push(pendingMode));req.resume();return;}
   req.resume();req.on('end', () => {
    const code = mode === 'auth' ? 401 : mode === 'rate' ? 429 : mode === 'model' ? 404 : 200;
    res.writeHead(code, {'Content-Type': 'application/json', ...(code === 429 ? {'Retry-After': '2'} : {})});
    res.end(JSON.stringify(code === 200 ? {id:'fixture',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'跨越语言阅读，能帮助我们理解彼此。工具保留原文，也让用户在服务暂不可用时恢复阅读。'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}
     : {error:{message:mode === 'model' ? 'model not found' : mode === 'rate' ? 'rate limit' : 'invalid api key', type:mode === 'auth' ? 'authentication_error' : 'invalid_request_error'}}));
   });
  });
  await new Promise((resolve, reject) => {server.once('error', reject);server.listen(0, '127.0.0.1', resolve);});
  const base = `http://127.0.0.1:${server.address().port}`;
  launchAttempted = true;
  session = await launchFocusSafePersistentContext({chromium, profileDir: profile, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background:true, headless:false, displayTarget:'secondary', viewport:{width:1100,height:850}, browserArgs:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check']});
  Object.assign(result, {launchMode:session.launchMode, focusPolicy:session.focusPolicy, windowPlacement:session.windowPlacement});
  const context = session.context;
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const open = async (url, viewport) => {const p = await newPageWithoutForeground(context);if(viewport)await p.setViewportSize(viewport);p.on('pageerror', e => result.consoleErrors.push(e.message));await p.goto(url);return p;};
  const source = await open(base + '/article', {width:1000,height:700});
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, source.url());
  let popup = await open(`chrome-extension://${id}/popup.html?sourceTabId=${tabId}`, {width:320,height:600});
  await popup.locator('[data-testid="onboarding-language-step"]').waitFor();await shot(popup, '01-install');
  await popup.locator('[data-language="zh-CN"]').evaluate(el => el.click());
  await popup.locator('.onboarding-form .onboarding-confirm').evaluate(el => el.click());
  await popup.locator('[data-testid="page-translation"]').waitFor({timeout:30000});record('fresh language selection reaches main action');await shot(popup, '02-first-action');
  if (args['live-default'] === 'true') {
   mode = 'live-default';await source.goto(base + '/article?default-live');await popup.reload();
   await popup.locator('[data-testid="page-translation"]').waitFor();
   assert.ok((await popup.locator('.provider-summary-heading strong').textContent()).includes('免费'));
   await popup.locator('[data-testid="page-translation"]').evaluate(el=>el.click());
   result.liveDefault = await pollValue(()=>readTranslationStatus(popup,tabId),value=>value?.status==='translated'||Boolean(value?.code),'default translation or diagnosis',120000);
   if(result.liveDefault.status==='translated')await popup.locator('[data-testid="page-translation"][aria-pressed="true"][aria-busy="false"]').waitFor();
   await shot(popup,'02-default-free-live');
   assert.equal(result.liveDefault.status,'translated','Default free translation must actually succeed for this live check.');record('live default free service translates public synthetic fixture');
   if(await popup.locator('[data-testid="page-translation"][aria-pressed="true"]').count())await popup.locator('[data-testid="page-translation"]').evaluate(el=>el.click());
   mode = 'success';await source.goto(base + '/article?local-fixtures');await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();
  }
  const patch = async (page, updates) => {
   const response = await page.evaluate(async ({updates, sequence}) => {
    const config = (await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value;
    const credentials = (await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value || {};
    const current = {...config, ...credentials};
    const expected = Object.fromEntries(Object.keys(updates).map(key => [key, current[key]]));
    return chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:updates,expected,clientId:'self-help-production-fixture',sequence});
   }, {updates, sequence:++sequence});
   assert.equal(response.success, true, JSON.stringify(response));
  };
  await patch(popup, {service:'openai',from:'auto',to:'zh',token:{openai:'fixture-local-only'},apiKeys:{openai:['fixture-local-only']},proxy:{openai:base+'/v1/chat/completions'},model:{openai:'gpt-4.1-mini'},customModel:{openai:''},enableAIContext:false,pageTitleTranslationEnabled:false});
  await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();
  const click = async selector => popup.locator(selector).evaluate(el => el.click());
  await click('[data-testid="page-translation"]');
  await waitForCompletedTranslation(popup,tabId);
  assert.ok(await source.locator('.fluentread-translation').count() || await source.locator('[data-fluentread-translation]').count() || (await source.content()).includes('跨越语言阅读'));
  record('first actual provider fixture result, not merely started');await shot(popup,'03-first-success');
  // 保持面板打开，同 URL 刷新后从独立消息触发翻译，仅靠新文档广播更新面板。
  await popup.evaluate(tabId=>{
   window.__selfHelpTransitions=[];
   chrome.runtime.onMessage.addListener((m,s)=>{if(m?.type==='fullPageTranslationState'&&s.tab?.id===tabId)window.__selfHelpTransitions.push({event:'message',at:Date.now(),status:m.toolbarStatus,active:m.isTranslated,token:m.documentToken,code:m.diagnostic?.code,sender:{id:s.id,url:s.url,tabUrl:s.tab?.url,frameId:s.frameId}});});
   chrome.tabs.onUpdated.addListener((id,change)=>{if(id===tabId&&change.status)window.__selfHelpTransitions.push({event:'tab',at:Date.now(),status:change.status});});
  },tabId);
  const refreshRounds=Number(args['refresh-rounds']||1);assert.ok(Number.isInteger(refreshRounds)&&refreshRounds>=1&&refreshRounds<=5);result.refreshRuns=[];
  for(let round=0;round<refreshRounds;round++) {
  const previousDocumentToken = await popup.evaluate(async tabId=>(await chrome.tabs.sendMessage(tabId,{type:'getFullPageTranslationState'},{frameId:0})).documentToken,tabId);
  await popup.evaluate(()=>{window.__selfHelpTransitions=[];});
  await source.reload();
  await popup.locator('[data-testid="page-translation"][aria-pressed="false"]').waitFor();
  // waitForFunction 不轮询异步 predicate；在 Node 侧逐次等待真实响应后判断就绪。
  result.refreshBefore = await pollValue(()=>popup.evaluate(async tabId=>{try{return await chrome.tabs.sendMessage(tabId,{type:'getFullPageTranslationState'},{frameId:0});}catch{return undefined;}},tabId),s=>s?.status==='success'&&typeof s.documentToken==='string'&&s.documentToken!==previousDocumentToken,'the refreshed document receiver');
  result.refreshAfterReady = await popup.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'getFullPageTranslationState'},{frameId:0}),tabId);
  result.refreshCommand = await popup.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'contextMenuTranslate',action:'fullPage'},{frameId:0}),tabId);
  assert.equal(result.refreshCommand?.status,'success','Refreshed document must acknowledge the independent translation command');assert.equal(result.refreshCommand.documentToken,result.refreshBefore.documentToken);assert.equal(result.refreshCommand.isTranslated,true);
  await waitForCompletedTranslation(popup,tabId);
  result.refreshTransitions=await popup.evaluate(()=>window.__selfHelpTransitions);result.previousDocumentToken=previousDocumentToken;
  result.refreshRuns.push({previousDocumentToken,before:result.refreshBefore,command:result.refreshCommand,transitions:result.refreshTransitions});
  }
  record('open popup rebinds same-URL refreshed document and accepts its live completion');
  await click('[data-testid="page-translation"]');
  for (const [testMode, expected] of [['auth','authentication'],['model','model-configuration'],['rate','rate-limit']]) {
   mode = testMode;
   // A new document removes translation cache identity while keeping the same fixed source tab.
   await source.goto(base + '/article?case=' + testMode);
   await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();await click('[data-testid="page-translation"]');
   await popup.locator(`[data-diagnostic-code="${expected}"]`).waitFor({timeout:30000});
   await assertCollapsedDiagnostic(popup,expected,testMode);await shot(popup,'04-' + testMode);record('actual '+testMode+' error classified');
   if (testMode === 'auth') {
    await previewDiagnostic(popup,'authentication');
    const report = await popup.locator('.diagnostic-report pre').textContent();
    await popup.locator('.diagnostic-report pre').focus();await popup.keyboard.press('Tab');
    assert.ok(await popup.locator('.diagnostic-report button').evaluate(el=>el===document.activeElement));record('keyboard reaches explicit export action');
    assert.ok(!/fixture-local-only|127\.0\.0\.1|article|invalid api key/.test(report));
    const [file] = await Promise.all([popup.waitForEvent('download'),popup.keyboard.press('Enter')]);await file.saveAs(path.join(out,'diagnostic.json'));record('local preview and explicit keyboard-triggered safe report download');
    result.afterDownloadState = await popup.evaluate(async tabId=>{const s=await chrome.tabs.sendMessage(tabId,{type:'getFullPageTranslationState'},{frameId:0});return {active:s?.isTranslated,status:s?.toolbarStatus,code:s?.diagnostic?.code};},tabId);await shot(popup,'05-report');
    await popup.locator('[data-diagnostic-code="authentication"]').waitFor({timeout:2000});
    await popup.keyboard.press('Escape');await assertCollapsedDiagnostic(popup,'authentication','authentication-after-report');
    assert.ok(await popup.locator('[data-diagnostic-details-toggle]').evaluate(el=>el===document.activeElement),'Escape must restore focus to the status trigger');
    const [settings] = await Promise.all([context.waitForEvent('page'),activateDiagnosticAction(popup,'services','authentication')]);await settings.waitForLoadState();await settings.setViewportSize({width:1100,height:850});
    await settings.locator('[data-editing-service="openai"]').waitFor({timeout:30000});
    await settings.locator('.connection-test-button').first().evaluate(el=>el.click());
    await settings.locator('[data-connection-repair][data-diagnostic-code="authentication"]').waitFor({timeout:30000});
    await shot(settings,'06-settings-repair');record('service repair opens exact service and detects actual 401');
    await settings.setViewportSize({width:390,height:760});
    await settings.locator('.connection-test-button').first().evaluate(el=>el.click());
    await settings.locator('[data-connection-repair][data-diagnostic-code="authentication"]').waitFor({timeout:30000});await shot(settings,'07-settings-narrow');
    assert.ok(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await settings.locator('[data-return-source-tab]').evaluate(el=>el.click());
    await pollValue(()=>settings.evaluate(async id=>(await chrome.tabs.get(id)).active,tabId),active=>active===true,'the original source tab to become active');record('explicit return keeps settings and original page available');
    await settings.close();
    popup = await open(`chrome-extension://${id}/popup.html?sourceTabId=${tabId}`,{width:320,height:600});
   }
  }
  await popup.emulateMedia({colorScheme:'dark'});await patch(popup,{theme:'dark'});await popup.reload();await popup.locator('[data-diagnostic-code="rate-limit"]').waitFor();await assertCollapsedDiagnostic(popup,'rate-limit','rate-dark');await shot(popup,'08-dark-rate');
  for (const failure of ['offline', 'timeout']) {
   mode = failure;await source.goto(base + '/article?case=' + failure);
   await patch(popup,{aiRequestTimeoutMs:10000});await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();
   if(failure==='offline')await context.setOffline(true);
   await click('[data-testid="page-translation"]');
   await popup.locator(`[data-diagnostic-code="${failure}"]`).waitFor({timeout:45000});
   await assertCollapsedDiagnostic(popup,failure,failure);await shot(popup,'09-'+failure);record('actual '+failure+' recovery state');
   await context.setOffline(false);mode = 'success';
   await activateDiagnosticAction(popup,'retry',failure);
   await waitForCompletedTranslation(popup,tabId);record('explicit retry resumes the same page after '+failure);
  }
  mode='hold';await source.goto(base+'/article?case=cancel');await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();await click('[data-testid="page-translation"]');
  let until=Date.now()+10000;while(!requests.some(r=>r.mode==='hold')&&Date.now()<until)await new Promise(r=>setTimeout(r,50));assert.ok(requests.some(r=>r.mode==='hold'));
  await click('[data-testid="page-translation"]');await popup.locator('[data-testid="page-translation"][aria-pressed="false"]').waitFor();
  until=Date.now()+3000;while(!closedPending.includes('hold')&&Date.now()<until)await new Promise(r=>setTimeout(r,50));assert.ok(closedPending.includes('hold'),'Restore must abort the pending provider request');record('cancel restores source and aborts in-flight local request');
  mode = 'success';await source.goto(base+'/empty');await popup.reload();await popup.locator('[data-testid="page-translation"]').waitFor();await click('[data-testid="page-translation"]');
  await popup.locator('[data-diagnostic-code="no-content"]').waitFor({timeout:30000});await assertCollapsedDiagnostic(popup,'no-content','no-content');await shot(popup,'09-no-content');record('no content diagnosis uses completed empty scan');
  await popup.close();popup=await open(`chrome-extension://${id}/popup.html?sourceTabId=${tabId}`,{width:320,height:600});await popup.locator('[data-diagnostic-code="no-content"]').waitFor();assert.equal(await popup.locator('.provider-summary-heading strong').textContent(),'OpenAI');record('reopen restores current page diagnosis and selected service');
  await patch(popup,{service:'openai',uiLanguage:'en-US',theme:'light'});await popup.reload();await popup.locator('[data-diagnostic-code="no-content"]').waitFor();result.localeLayouts={'en-US':await fitNativePopup(popup)};await assertCollapsedDiagnostic(popup,'no-content','en-US');await shot(popup,'10-english');
  if(args.locales==='true') {
   for(const [locale,title] of [['ja-JP','本文が見つかりません'],['ko-KR','본문을 찾지 못함'],['fr-FR','Aucun texte trouvé'],['ru-RU','Текст не найден'],['es-ES','No se encontró texto']]) {
    await patch(popup,{uiLanguage:locale});await popup.reload();
    await popup.locator('[data-diagnostic-code="no-content"] [data-diagnostic-summary]').filter({hasText:title}).waitFor();
    assert.equal(await popup.locator('[data-diagnostic-code="no-content"] [data-diagnostic-summary]').textContent(),title);
    result.localeLayouts[locale]=await fitNativePopup(popup);
    await assertCollapsedDiagnostic(popup,'no-content',locale);await previewDiagnostic(popup,'no-content');
    assert.ok(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await shot(popup,'11-'+locale);record('localized diagnosis and local report preview in '+locale);
   }
  }
  assert.equal(result.consoleErrors.length,0,JSON.stringify(result.consoleErrors));result.ok=true;
 } catch(error) {result.ok=false;result.error=error.stack;
  if(session)for(const [index,p] of session.context.pages().entries()){try{await shot(p,'failure-'+index);if(p.url().includes('/popup.html')){result.popupText=await p.locator('body').innerText();result.failureState=await p.evaluate(async()=>{const tabId=Number(new URL(location.href).searchParams.get('sourceTabId'));let state;try{const s=await chrome.tabs.sendMessage(tabId,{type:'getFullPageTranslationState'},{frameId:0});state={active:s?.isTranslated,status:s?.toolbarStatus,token:s?.documentToken,code:s?.diagnostic?.code};}catch(e){state={queryFailed:true};}return {state,transitions:window.__selfHelpTransitions};});}}catch{}}
 }
 finally {
  let cleanupConfirmed = !launchAttempted;
  if(session)try{await session.close();cleanupConfirmed=true;}catch(e){result.cleanupError=e.message;result.ok=false;}
  result.cleanupConfirmed=cleanupConfirmed;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(cleanupConfirmed)fs.rmSync(profile,{recursive:true,force:true});else result.retainedProfile=profile;
  result.profileRemoved=!fs.existsSync(profile);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2));
 }
 console.log(JSON.stringify({ok:result.ok,cases:result.cases,error:result.error,report:path.join(out,'report.json')}));
 process.exitCode=result.ok?0:1;
})();
