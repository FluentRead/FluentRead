#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-import-recovery-ui-test.cjs
 * 文件职责：限定验证术语库导入或圈选失败恢复的生产界面，不启动全量 UI 回归。
 * 主要内容：真实配置、文件导入、粘贴、预览、持久化与主题布局；圈选使用真实截图和本机 AI HTTP 夹具，验证缺包、空识别、配置错误及恢复。
 * 模块边界：只操作第二屏后台临时 Edge；仅写合成配置，不使用用户密钥或线上翻译服务；保留完整运行时诊断并清理本轮 profile。
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const suite=arg('suite');assert(['glossary','area'].includes(suite),'Pass --suite glossary or --suite area');
const extensionDir=path.resolve(arg('extension-dir','.output/chrome-mv3'));
const artifacts=path.resolve(arg('artifacts-dir'));fs.mkdirSync(artifacts,{recursive:true});
const packages=arg('playwright-root',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'));
const {chromium}=require(path.join(packages,'playwright'));
const helper=require('./focus-safe-browser.cjs');
const diagnostics=require(path.resolve(arg('runtime-diagnostics-helper'))).createRuntimeDiagnostics();
const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-import-recovery-'));
const report={ok:false,suite,extensionDir,cases:[],screenshots:[],cleanupErrors:[],requests:[],limitations:['Only isolated Edge production UI; no Firefox/Safari/physical mobile acceptance.','Area requests use a loopback AI fixture, not an external provider. OCR-pack download itself is covered by component recovery tests.']};
let session,page,control,cdp,server,origin,sequence=0,serverMode='ok';
const csv='source,target,tgt_lng\nalpha,甲,zh-Hans\nbeta,乙,zh-Hans\ngamma,丙,zh-Hans\ndelta,丁,zh-Hans';
async function config(){return control.evaluate(async()=>{const r=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});return typeof r.value==='string'?JSON.parse(r.value):r.value;});}
async function patch(values,initial=false){await control.evaluate(async({values,initial,sequence})=>{const r=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});const current=typeof r.value==='string'?JSON.parse(r.value):r.value;const result=await chrome.runtime.sendMessage({type:'persistConfig',mode:initial?'replace':'patch',config:initial?{...current,...values}:values,expected:Object.fromEntries(Object.keys(values).map(k=>[k,current[k]])),clientId:'import-recovery-fixture',sequence,baseRevision:current.__fluentConfigRevision||0});if(!result.success)throw new Error(result.error);},{values,initial,sequence:++sequence});}
async function newPage(url,label){const p=await helper.newPageWithoutForeground(session.context,30000);p.setDefaultTimeout(20000);await diagnostics.attachPage(p,label);await p.goto(url);return p;}
async function capture(name,locator){const file=path.join(artifacts,`${name}.png`);if(locator)await locator.screenshot({path:file,animations:'disabled',scale:'css'});else await page.screenshot({path:file,animations:'disabled',scale:'css'});report.screenshots.push(file);}
function passed(name,extra={}){report.cases.push({name,ok:true,...extra});diagnostics.setPhase(name);}
async function glossary(){
  const existing={id:'existing',name:'Existing glossary',enabled:true,sourceLanguage:'',targetLanguage:'zh-hans',domains:[],entries:[{id:'original',source:'kept',target:'保留',caseSensitive:false}]};
  await patch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',glossaryEnabled:true,glossaryLibraries:[existing]},true);
  page=await newPage(`${origin}/options.html#settings-glossary`,'glossary-options');
  await helper.activateExtensionTabWithoutForeground(session.context,page,30000);
  await page.getByTestId('glossary-settings').waitFor();
  const open=async()=>{await page.getByRole('button',{name:'导入术语库',exact:true}).click();await page.getByRole('dialog',{name:'导入术语库',exact:true}).waitFor();};
  await open();const dialog=page.locator('.glossary-import-dialog');
  const fit=async name=>{const m=await dialog.evaluate(n=>{const r=n.getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,overflow:n.scrollWidth-n.clientWidth};});assert(m.overflow<=1&&m.left>=0&&m.right<=m.viewportWidth+1&&m.top>=0&&m.bottom<=m.viewportHeight+1,JSON.stringify(m));await capture(name,dialog);passed(name,m);};
  assert.equal(await dialog.getByRole('textbox').count(),0);const spacing=await dialog.evaluate(n=>n.querySelector('.glossary-import-file').getBoundingClientRect().top-n.querySelector('.glossary-import-methods').getBoundingClientRect().bottom);assert(spacing>=16,'Import sections need visible separation');const arrow=await dialog.locator('.glossary-import-format > summary').evaluate(n=>({display:getComputedStyle(n,'::after').display,content:getComputedStyle(n,'::after').content}));assert(arrow.display==='none'||['none','normal'].includes(arrow.content),'A disclosure must not render a second automatic chevron');assert.equal(await dialog.getByRole('button',{name:'确认导入',exact:true}).isEnabled(),false);await fit('glossary-file-empty');
  await dialog.locator('input[type=file]').setInputFiles({name:'一份文件名较长的术语库-用于检查导入文件名称换行.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await dialog.locator('.glossary-import-sample').waitFor();assert.equal(await dialog.locator('tbody tr').count(),3);assert.equal(await dialog.locator('.glossary-import-preview').evaluate(n=>n.open),false);
  assert.equal((await config()).glossaryLibraries.length,1);await fit('glossary-file-preview');
  await dialog.getByRole('radio',{name:'粘贴内容',exact:true}).check();const textbox=dialog.getByRole('textbox',{name:'粘贴内容',exact:true});
  const warning='source,target,tgt_lng,note\npasted,粘贴术语,zh-Hans,extra';await textbox.fill(warning);
  await dialog.getByRole('checkbox').waitFor();assert.equal(await dialog.getByRole('button',{name:'确认导入',exact:true}).isEnabled(),false);
  await dialog.getByRole('radio',{name:'选择文件',exact:true}).check();assert.equal(await dialog.locator('tbody tr').count(),3);
  await dialog.getByRole('radio',{name:'粘贴内容',exact:true}).check();assert.equal(await textbox.inputValue(),warning);
  await fit('glossary-paste-warning');await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const saved=await config();assert.equal(saved.glossaryLibraries.length,2);assert.deepEqual(saved.glossaryLibraries[0],existing);assert.equal(saved.glossaryLibraries[1].entries[0].source,'pasted');passed('explicit-import-preserves-existing-and-current-method');
  await page.reload();await page.getByTestId('glossary-settings').waitFor();assert.equal((await config()).glossaryLibraries.length,2);passed('import-survives-reopen');
  await open();await dialog.locator('input[type=file]').setInputFiles({name:'preview.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await dialog.locator('.glossary-import-sample').waitFor();
  const lightSurface=await dialog.evaluate(n=>getComputedStyle(n).backgroundColor);await patch({theme:'dark'});await page.waitForFunction(light=>getComputedStyle(document.querySelector('.glossary-import-dialog')).backgroundColor!==light,lightSurface);
  await fit('glossary-dark');await patch({theme:'light'});
  await page.setViewportSize({width:390,height:740});await fit('glossary-narrow');
  await page.setViewportSize({width:320,height:568});await fit('glossary-small');
  await page.setViewportSize({width:390,height:340});await fit('glossary-short');
  const footer=await dialog.getByRole('button',{name:'确认导入',exact:true}).boundingBox();assert(footer.y>=0&&footer.y+footer.height<=340);passed('short-viewport-confirm-visible');
  await page.setViewportSize({width:980,height:800});await patch({uiLanguage:'en-US'});await dialog.getByRole('button',{name:'Confirm import',exact:true}).waitFor();await fit('glossary-english');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal((await config()).glossaryLibraries.length,2);passed('cancel-keeps-import-unapplied');
}
async function areaDom(code){const tree=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});let host;function visit(n){const a=n.attributes||[];for(let i=0;i<a.length;i+=2)if(a[i]==='id'&&a[i+1]==='fluent-read-area-translator-container')host=n;for(const c of [...(n.children||[]),...(n.shadowRoots||[])])visit(c);}visit(tree.root);if(!host?.shadowRoots?.[0])return null;const {object}=await cdp.send('DOM.resolveNode',{nodeId:host.shadowRoots[0].nodeId});try{const r=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){${code}}`,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}}
async function waitArea(test){const until=Date.now()+30000;while(Date.now()<until){if(await test())return;await page.waitForTimeout(80);}throw new Error(`Area state timed out: ${await areaDom('return this.textContent')}`);}
async function areaClick(text){let target=await areaDom(`const n=[...this.querySelectorAll('button,summary')].find(n=>n.textContent.trim()===${JSON.stringify(text)}||n.getAttribute('aria-label')===${JSON.stringify(text)});if(!n)return null;const d=n.closest('details');const e=d&&!d.open?d.querySelector('summary'):n;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,expand:e!==n};`);assert(target,text);await page.mouse.click(target.x,target.y);if(target.expand){target=await areaDom(`const n=[...this.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);await page.mouse.click(target.x,target.y);}}
async function areaShot(name){await waitArea(()=>areaDom("const n=this.querySelector('.fr-area-panel');if(!n)return false;const r=n.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;"));const m=await areaDom("const n=this.querySelector('.fr-area-panel'),r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,overflow:n.scrollWidth-n.clientWidth,right:r.right,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};");assert(m.overflow<=1&&m.x>=0&&m.y>=0&&m.right<=m.viewportWidth+1&&m.bottom<=m.viewportHeight+1,JSON.stringify(m));const file=path.join(artifacts,`${name}.png`);await page.screenshot({path:file,clip:{x:m.x,y:m.y,width:m.width,height:m.height},animations:'disabled',scale:'css'});report.screenshots.push(file);passed(name,m);}
async function area(){
  const model='gpt-4.1-mini',base=`http://127.0.0.1:${server.address().port}`;
  await patch({on:true,selectionAreaEnabled:true,disableImageTranslator:true,disableSelectionTranslator:true,from:'en',to:'zh-Hans',uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',service:'openai',areaTranslationService:'',areaTranslationMode:'standard',areaRecognitionMode:'prefer-vision',model:{openai:model},modelVision:{openai:{[model]:true}},token:{openai:'fixture-not-real'},proxy:{openai:`${base}/v1/chat/completions`},translationMaxRetries:0},true);
  page=await newPage(base,'area-fixture');await helper.activateExtensionTabWithoutForeground(session.context,page,30000);cdp=await session.context.newCDPSession(page);
  const select=async()=>{await page.locator('h1').click();await page.keyboard.press('Shift+Z');await waitArea(()=>areaDom("return !!this.querySelector('.fr-area-selecting')"));const r=await page.locator('#sample').boundingBox();await page.mouse.move(r.x,r.y);await page.mouse.down();await page.mouse.move(r.x+r.width,r.y+r.height,{steps:5});await page.mouse.up();};
  const failure=async kind=>{await waitArea(()=>areaDom(`return this.querySelector('.fr-area-primary')?.dataset.recovery===${JSON.stringify(kind)}`));assert.equal(await areaDom("return this.querySelectorAll('.fr-area-primary').length"),1);assert.equal(await areaDom("return this.querySelector('.fr-area-error-details').open"),false);assert.equal(await areaDom("return this.querySelector('.fr-area-more').open"),false);};
  serverMode='auth';await select();await failure('settings');await areaShot('area-service-error');
  await patch({theme:'dark'});await waitArea(()=>areaDom("return this.querySelector('.fr-area-translator-root').classList.contains('fr-area-dark')"));await areaShot('area-service-error-dark');
  await patch({theme:'light'});await page.setViewportSize({width:390,height:740});await areaShot('area-error-narrow');
  await areaClick('查看详细原因');await areaShot('area-error-details');await areaClick('查看详细原因');
  serverMode='ok';const before=report.requests.length;await areaClick('重试');await waitArea(()=>areaDom("return !!this.querySelector('.fr-area-translation')"));assert(report.requests.length>before);passed('area-retry-through-other-actions');
  await page.setViewportSize({width:1280,height:900});serverMode='empty';await areaClick('重新翻译');await failure('empty');await areaShot('area-no-text');
  serverMode='ok';await areaClick('重新圈选');await waitArea(()=>areaDom("return !!this.querySelector('.fr-area-selecting')"));await page.keyboard.press('Escape');passed('empty-text-reselect-and-escape');
  await patch({areaRecognitionMode:'ocr',modelVision:{openai:{[model]:false}}});await select();await failure('languages');await areaShot('area-language-pack');
  await patch({uiLanguage:'en-US'});await waitArea(()=>areaDom("return this.querySelector('[role=alert]')?.textContent.includes('An OCR language pack')"));await areaShot('area-language-pack-english');
  await page.keyboard.press('Escape');await waitArea(()=>areaDom("return !this.querySelector('.fr-area-panel')"));passed('area-escape-close');
}
async function main(){
  server=http.createServer((request,response)=>{response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','*');if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}if(request.method==='POST'){let body='';request.on('data',c=>{body+=c;});request.on('end',()=>{try{const payload=JSON.parse(body),image=payload.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'));report.requests.push({image,mode:serverMode,model:payload.model});response.setHeader('content-type','application/json');if(serverMode==='auth'){response.writeHead(401);response.end(JSON.stringify({error:{message:'fixture auth failure'}}));return;}response.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:payload.model,choices:[{index:0,message:{role:'assistant',content:image?(serverMode==='empty'?'[无可识别文字]':'Selected fixture text.'):'测试译文。'},finish_reason:'stop'}]}));}catch(error){response.writeHead(500);response.end(error.message);}});return;}response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><head><title>Area recovery fixture</title><style>body{font:16px system-ui;padding:30px;background:#f7f8fc}#sample{padding:24px;width:600px;height:160px;background:white;font-size:24px}button{background:red!important;color:lime!important}</style></head><body><h1>Area recovery fixture</h1><div id="sample">Selected fixture text.<br>Keep the original area for retry.</div></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  session=await helper.launchFocusSafePersistentContext({chromium:{connectOverCDP:(endpoint,options)=>chromium.connectOverCDP(endpoint,{...options,noDefaults:true})},profileDir,browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,displayTarget:'secondary',viewport:{width:1280,height:900},browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check'],timeout:30000});
  Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});assert.equal(session.windowPlacement.browserFrontmost,false);
  await diagnostics.start(session.context);const worker=session.context.serviceWorkers()[0]||await session.context.waitForEvent('serviceworker');origin=`chrome-extension://${new URL(worker.url()).host}`;diagnostics.setExtensionId(new URL(worker.url()).host);
  control=await newPage(`${origin}/popup.html`,'configuration-control');
  if(suite==='glossary')await glossary();else await area();
  await diagnostics.flush();diagnostics.assertClean();report.ok=true;
}
main().catch(async error=>{report.failure=String(error.stack||error);process.exitCode=1;if(page)await capture('failure').catch(()=>{});}).finally(async()=>{
  await diagnostics.flush();report.runtimeDiagnostics=diagnostics.snapshot();await diagnostics.stop();
  fs.writeFileSync(path.join(artifacts,'runtime-diagnostics.json'),JSON.stringify(report.runtimeDiagnostics,null,2));
  let browserClosed=false;if(session)try{await session.close();browserClosed=true;}catch(error){report.cleanupErrors.push(String(error));report.ok=false;process.exitCode=1;}
  if(browserClosed)fs.rmSync(profileDir,{recursive:true,force:true});else report.retainedProfile=profileDir;if(server)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,failure:report.failure,report:path.join(artifacts,'report.json')}));
});
