#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-dialog-recovery-ui-test.cjs
 * 文件职责：限定验证统一任务弹窗、备份导出与恢复、划词和图片失败提示的生产界面。
 * 主要内容：后台临时 Edge、真实文件与可信手势、深浅色和小视口；网络只用本机服务夹具，采集运行时诊断和截图。
 * 模块边界：只使用本轮临时配置与合成数据，不连接用户浏览器、不使用真实密钥、不下载模型；确认框的取消必须不触发导出。
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const arg=(key,fallback)=>{const i=process.argv.indexOf('--'+key);return i<0?fallback:process.argv[i+1];};
const suite=arg('suite');assert(['backup','dialogs','translation'].includes(suite),'Pass --suite backup, dialogs or translation');
const extensionDir=path.resolve(arg('extension-dir','.output/chrome-mv3')),artifacts=path.resolve(arg('artifacts-dir'));
fs.mkdirSync(artifacts,{recursive:true});
const {chromium}=require(path.join(arg('playwright-root',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')),'playwright'));
const helper=require('./focus-safe-browser.cjs'),diagnostics=require(path.resolve(arg('runtime-diagnostics-helper'))).createRuntimeDiagnostics();
const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-dialog-recovery-'));
const report={ok:false,suite,extensionDir,cases:[],screenshots:[],requests:[],cleanupErrors:[],limitations:['Isolated Edge production UI; no Firefox/native mobile acceptance.','Synthetic config and loopback provider responses; no live provider, cloud account or language-pack download validation.']};
let session,page,control,cdp,server,origin,sequence=0,serverMode='auth';
const nativeDownloads=[];
async function downloadedAfter(action){const count=nativeDownloads.length;await action();await wait(()=>nativeDownloads.length>count&&nativeDownloads[count].state==='completed');const d=nativeDownloads[count];assert(fs.existsSync(d.file));return JSON.parse(fs.readFileSync(d.file,'utf8'));}
const passed=(name,extra={})=>{report.cases.push({name,ok:true,...extra});diagnostics.setPhase(name);};
async function config(){return control.evaluate(async()=>{const r=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});return typeof r.value==='string'?JSON.parse(r.value):r.value;});}
async function patch(values,initial=false){await control.evaluate(async({values,sequence,initial})=>{const r=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});const current=typeof r.value==='string'?JSON.parse(r.value):r.value;const result=await chrome.runtime.sendMessage({type:'persistConfig',mode:initial?'replace':'patch',config:initial?{...current,...values}:values,expected:Object.fromEntries(Object.keys(values).map(k=>[k,current[k]])),clientId:'dialog-recovery-fixture',sequence,baseRevision:current.__fluentConfigRevision||0});if(!result.success)throw Error(result.error);},{values,sequence:++sequence,initial});}
async function newPage(url,label){const p=await helper.newPageWithoutForeground(session.context,30000);p.setDefaultTimeout(15000);await diagnostics.attachPage(p,label);await p.goto(url);return p;}
async function wait(test){const until=Date.now()+15000;while(Date.now()<until){if(await test())return;await new Promise(r=>setTimeout(r,70));}throw Error('Expected UI state did not arrive');}
async function shot(name,locator){const file=path.join(artifacts,name+'.png');if(await page.locator('.el-message').count())await page.locator('.el-message').last().waitFor({state:'hidden'});await locator.evaluate(n=>Promise.allSettled(n.getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished)));const m=await locator.evaluate(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,overflow:n.scrollWidth-n.clientWidth};});assert(m.x>=-1&&m.y>=-1&&m.right<=m.viewportWidth+1&&m.bottom<=m.viewportHeight+1&&m.overflow<=1,JSON.stringify(m));await locator.screenshot({path:file,animations:'disabled',scale:'css'});report.screenshots.push(file);passed(name,m);}
async function options(){await patch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light'});page=await newPage(origin+'/options.html#settings-data','options');await helper.activateExtensionTabWithoutForeground(session.context,page,30000);await page.locator('.transfer-actions').waitFor();await page.evaluate(()=>{globalThis.__frFixtureFeedback=[];new MutationObserver(()=>{for(const n of document.querySelectorAll('.el-message'))if(n.textContent&&!globalThis.__frFixtureFeedback.includes(n.textContent))globalThis.__frFixtureFeedback.push(n.textContent);}).observe(document.body,{subtree:true,childList:true,characterData:true});});}
async function backup(){
  await options();const dialog=page.locator('.fr-backup-export-dialog');
  const open=async()=>{await page.locator('.transfer-actions').getByRole('button',{name:'导出备份',exact:true}).click();await dialog.waitFor();};
  const downloads=()=>nativeDownloads.length;
  await open();assert.equal(await dialog.getByRole('checkbox').isChecked(),false);await shot('backup-export',dialog);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(downloads(),0);passed('export-cancel-does-not-download');
  await open();const data=await downloadedAfter(()=>dialog.getByRole('button',{name:'导出备份',exact:true}).click());assert.equal(data.vocabulary.includesPrivateContext,false);passed('export-default-excludes-context');
  await open();await dialog.getByRole('checkbox').check();const withContext=await downloadedAfter(()=>dialog.getByRole('button',{name:'导出备份',exact:true}).click());assert.equal(withContext.vocabulary.includesPrivateContext,true);passed('export-context-requires-checkbox');
  await page.locator('.transfer-actions').getByRole('button',{name:'从备份恢复',exact:true}).click();
  const source=page.getByTestId('restore-source-dialog');await shot('backup-restore-source',source);
  await source.locator('summary').click();await shot('backup-restore-paste',source);
  await source.locator('summary').click();data.config.to='fr';
  await page.locator('.local-data-management input[type=file]').setInputFiles({name:'一份文件名较长的示例备份-用于检查换行和恢复内容.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  const preview=page.getByTestId('local-data-import-dialog');await preview.waitFor();assert.equal(await preview.locator('.config-import-preview').evaluate(n=>n.open),false);assert.equal(await preview.locator('.import-section-grid article').count(),3);await shot('backup-restore-preview',preview);
  await preview.locator('.config-import-preview > summary').click();await shot('backup-restore-changes',preview);
  await preview.locator('.config-import-preview > summary').click();await patch({theme:'dark'});await page.locator('html.dark').waitFor();await shot('backup-restore-dark',preview);
  await patch({theme:'light'});await page.setViewportSize({width:390,height:600});await shot('backup-restore-narrow',preview);
  await page.setViewportSize({width:390,height:340});const footer=preview.locator('.el-dialog__footer');await footer.getByRole('button',{name:'确认导入'}).waitFor();await shot('backup-restore-short',preview);
  await page.setViewportSize({width:1100,height:820});await preview.getByRole('button',{name:'确认导入',exact:true}).click();await preview.waitFor({state:'hidden'});await wait(async()=>(await config()).to==='fr');passed('restore-confirm-persists-config');
  await patch({uiLanguage:'en-US'});await page.locator('.transfer-actions').getByRole('button',{name:'Export backup',exact:true}).click();await dialog.waitFor();await shot('backup-export-english',dialog);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
}
async function dialogs(){
  await options();await page.getByRole('radio',{name:'WebDAV',exact:true}).check();await page.getByTestId('webdav-setup').click();const webdav=page.locator('.webdav-settings-dialog');await webdav.waitFor();await shot('webdav-connection',webdav);await webdav.getByRole('button',{name:'取消',exact:true}).click();
  await patch({to:'fr'});await patch({to:'en'});await page.getByRole('button',{name:'设置历史',exact:true}).click();await page.locator('.version-entry').first().click();const history=page.locator('.config-preview-dialog');await history.waitFor();await shot('settings-history-preview',history);await history.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.getByRole('button',{name:'备份与导入',exact:true}).click();await page.getByTestId('cloud-include-sensitive').first().click();const consent=page.locator('.cloud-consent-dialog');await consent.waitFor();await shot('cloud-sensitive-consent',consent);await consent.locator('.el-dialog__footer .el-button').first().click();
  await page.locator('button[data-section=settings-services]').click();await page.getByTestId('custom-service-add').click();const custom=page.getByTestId('custom-service-dialog');await custom.waitFor();await shot('service-create',custom);
  await page.setViewportSize({width:390,height:660});await shot('service-create-narrow',custom);await patch({theme:'dark'});await page.locator('html.dark').waitFor();await shot('service-create-dark',custom);
  await custom.getByRole('button',{name:'取消',exact:true}).click();passed('dialog-cancel-keeps-provider-list');
}
async function shadow(selector,code){
  const tree=await cdp.send('DOM.getDocument',{depth:-1,pierce:true}),roots=[];
  const visit=n=>{for(const root of n.shadowRoots||[]){roots.push(root);visit(root);}for(const child of n.children||[])visit(child);};visit(tree.root);
  for(const root of roots){const {object}=await cdp.send('DOM.resolveNode',{nodeId:root.nodeId});try{const r=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const n=this.querySelector('+JSON.stringify(selector)+');if(!n)return null;'+code+'}',returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);if(r.result.value!==null&&r.result.value!==undefined)return r.result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}}return null;
}
async function shadowClick(selector){const target=await shadow(selector,'const d=n.closest("details");const e=d&&!d.open?d.querySelector("summary"):n;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,expand:e!==n};');assert(target,selector);await page.mouse.click(target.x,target.y);if(target.expand)await shadowClick(selector);}
async function shadowShot(name,selector){await wait(()=>shadow(selector,'const r=n.getBoundingClientRect();return r.width>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;'));const m=await shadow(selector,'const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,overflow:n.scrollWidth-n.clientWidth};');assert(m.overflow<=1);const file=path.join(artifacts,name+'.png');await page.screenshot({path:file,clip:{x:m.x,y:m.y,width:m.width,height:m.height},animations:'disabled',scale:'css'});report.screenshots.push(file);passed(name,m);}
async function translation(){
  const model='gpt-4.1-mini',base='http://127.0.0.1:'+server.address().port;
  await patch({on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',from:'en',to:'zh-Hans',selectionTranslatorMode:'bilingual',selectionTranslatorTrigger:'direct',selectionTranslationService:'',service:'openai',model:{openai:model},token:{openai:'fixture-not-real'},proxy:{openai:base+'/v1/chat/completions'},translationMaxRetries:0,disableImageTranslator:true},true);
  page=await newPage(base,'translation-fixture');await helper.activateExtensionTabWithoutForeground(session.context,page,30000);cdp=await session.context.newCDPSession(page);
  const checkpoint=diagnostics.checkpoint();await page.locator('#sample').click({clickCount:3});await wait(()=>shadow('.fr-error-state','return n.textContent.includes("密钥或权限无效");'));
  assert.equal(await shadow('.fr-error-state','return n.querySelectorAll(".fr-recovery-primary").length;'),1);assert.equal(await shadow('.fr-recovery-more','return n.open;'),false);await shadowShot('selection-service-error','.fr-translation-tooltip');
  await patch({theme:'dark'});await wait(()=>shadow('.fr-dark-theme .fr-error-state','return true;'));await shadowShot('selection-service-dark','.fr-translation-tooltip');
  await patch({theme:'light'});await page.setViewportSize({width:390,height:650});await shadowShot('selection-service-narrow','.fr-translation-tooltip');
  serverMode='ok';await shadowClick('.fr-recovery-more > button');await wait(()=>shadow('.fr-translation-container','return n.textContent.includes("测试译文");'));passed('selection-retry-keeps-original-selection');
  await diagnostics.flush();report.expectedDiagnostics=diagnostics.expectSince(checkpoint,{caseId:'selection-auth-fixture-once',surface:'translation-fixture',exactMessages:['Selection translation error: TranslationError: 当前翻译服务的 API Key 无效、已过期或没有模型访问权限（HTTP 401）。请检查服务配置。'],maxCount:1});
  await shadowClick('.fr-close-btn');await patch({selectionTranslatorMode:'disabled',disableImageTranslator:false,imageTranslationOcrEngine:'tesseract',from:'ja'});await page.setViewportSize({width:1100,height:820});await page.locator('h1').click();await page.locator('#picture').hover();await wait(()=>shadow('.fluent-read-image-translation-button','return !n.hidden&&n.getBoundingClientRect().width>0;'));await shadowClick('.fluent-read-image-translation-button');
  await wait(()=>shadow('.fr-image-feedback[data-phase=error]','return n.dataset.preparation==="true";'));assert.equal(await shadow('.fr-image-more','return n.open;'),false);assert.equal(await shadow('.fr-image-actions','return [...n.children].filter(e=>e.tagName==="BUTTON"&&!e.hidden).length;'),1);await shadowShot('image-language-pack','.fr-image-feedback[data-phase=error]');await shadowClick('.fr-image-more > summary');await shadowShot('image-other-actions','.fr-image-feedback[data-phase=error]');await shadowClick('.fr-image-more .fluent-read-image-translation-button');await wait(async()=>!(await shadow('.fr-image-feedback','return !n.hidden;')));assert.equal(await page.locator('#picture').evaluate(n=>getComputedStyle(n).opacity),'1');passed('image-dismiss-keeps-original');
}
async function main(){
  server=http.createServer((request,response)=>{response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','*');if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}if(request.method==='POST'){let body='';request.on('data',c=>body+=c);request.on('end',()=>{try{const payload=JSON.parse(body);report.requests.push({mode:serverMode,model:payload.model});response.setHeader('content-type','application/json');if(serverMode==='auth'){response.writeHead(401);response.end(JSON.stringify({error:{message:'fixture auth failure'}}));}else response.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:payload.model,choices:[{index:0,message:{role:'assistant',content:'测试译文。'},finish_reason:'stop'}]}));}catch{response.writeHead(400);response.end();}});return;}response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><head><title>Translation recovery fixture</title><style>body{font:18px system-ui;padding:40px;background:#f7f8fc}p{max-width:650px}img{display:block;width:560px;max-width:90vw;height:auto;margin-top:80px}button{color:lime!important;background:red!important}</style></head><body><h1>Translation recovery fixture</h1><p id="sample">A clear reading experience keeps the next action easy to find.</p><img id="picture" alt="Synthetic text fixture"><script>const c=document.createElement("canvas");c.width=700;c.height=340;const x=c.getContext("2d");x.fillStyle="white";x.fillRect(0,0,700,340);x.fillStyle="black";x.font="32px sans-serif";x.fillText("A clear reading experience.",30,100);document.querySelector("img").src=c.toDataURL();</script></body></html>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  session=await helper.launchFocusSafePersistentContext({chromium:{connectOverCDP:(url,opts)=>chromium.connectOverCDP(url,{...opts,noDefaults:true})},profileDir,browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,displayTarget:'secondary',viewport:{width:1280,height:900},browserArgs:['--disable-extensions-except='+extensionDir,'--load-extension='+extensionDir,'--no-first-run','--no-default-browser-check'],timeout:30000});
  Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});assert.equal(session.windowPlacement.browserFrontmost,false);
  const downloadDir=path.join(artifacts,'synthetic-downloads');fs.mkdirSync(downloadDir);const browserCdp=await session.context.browser().newBrowserCDPSession();
  await browserCdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:downloadDir,eventsEnabled:true});
  browserCdp.on('Browser.downloadWillBegin',event=>nativeDownloads.push({guid:event.guid,name:event.suggestedFilename,file:path.join(downloadDir,event.guid),state:'pending'}));
  browserCdp.on('Browser.downloadProgress',event=>{const item=nativeDownloads.find(d=>d.guid===event.guid);if(item)item.state=event.state;});
  report.downloadDriver='CDP Browser native downloads; temporary profile only';
  await diagnostics.start(session.context);const worker=session.context.serviceWorkers()[0]||await session.context.waitForEvent('serviceworker');origin='chrome-extension://'+new URL(worker.url()).host;diagnostics.setExtensionId(new URL(worker.url()).host);control=await newPage(origin+'/popup.html','configuration-control');
  if(suite==='backup')await backup();else if(suite==='dialogs')await dialogs();else await translation();
  await diagnostics.flush();diagnostics.assertClean();report.ok=true;
}
main().catch(async error=>{report.failure=String(error.stack||error);report.nativeDownloads=nativeDownloads;process.exitCode=1;if(page)try{report.uiFeedback=await page.evaluate(()=>globalThis.__frFixtureFeedback);await page.screenshot({path:path.join(artifacts,'failure.png')});}catch(cause){report.captureError=String(cause);}}).finally(async()=>{
  await diagnostics.flush();report.runtimeDiagnostics=diagnostics.snapshot();await diagnostics.stop();let closed=false;
  if(session)try{await session.close();closed=true;}catch(error){report.cleanupErrors.push(String(error));report.ok=false;process.exitCode=1;}
  if(closed)fs.rmSync(profileDir,{recursive:true,force:true});else report.retainedProfile=profileDir;if(server)await new Promise(r=>server.close(r));
  fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,failure:report.failure,report:path.join(artifacts,'report.json')}));
});

