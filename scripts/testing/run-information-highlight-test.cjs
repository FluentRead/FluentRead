#!/usr/bin/env node
/**
 * @file scripts/testing/run-information-highlight-test.cjs
 * 文件职责：在独立真实 Edge 中验证生产信息高亮的页面保护、启停、动态正文、可选模型与设置持久化。
 * 主要内容：通过现有后台无焦点浏览器 helper 加载本地扩展和只读正文 fixture，真实点击设置、说明、渐变与模型选项，以真实按键验证快捷键作用范围；按 --model-id 选择固定 Qwen2.5 或 Qwen3，校验各自缓存、离线推理标签、单按钮文案及取消/确认删除流程；分阶段保存证据，显式选择真实下载或校验后的本地导入。
 * 模块边界：只清理本次 profile；本地导入与产品下载证据分开记录，下载后的推理和 PDF 复用已有页签；不修改共享焦点策略，超时和断开均失败，网络观察不冒充全机流量或阅读效果证明。
 */
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createHash,randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const support=require('../run-selection-trigger-test.cjs');
const {createRequire}=require('node:module');
const {guardBrowserClose,getGuardedBrowserPid}=require('./owned-browser-close.cjs');
const args={};
for(let i=2;i<process.argv.length;i++){
  const argument=process.argv[i];assert(argument.startsWith('--'),`Unexpected argument: ${argument}`);
  const field=argument.slice(2),next=process.argv[i+1];
  if(['download-model','paint-diagnose'].includes(field)){
    if(next&&!next.startsWith('--')){assert(['true','false','1','0'].includes(next),`Invalid --${field} value`);args[field]=next==='true'||next==='1';i++;}
    else args[field]=true;
  }else{assert(next&&!next.startsWith('--'),`Missing --${field} value`);args[field]=next;i++;}
}
assert(!(args['download-model']&&args['model-dir']),'--download-model and --model-dir are mutually exclusive');
const models={
  'qwen2.5-0.5b':{id:'qwen2.5-0.5b',name:'Qwen2.5 0.5B',repository:'onnx-community/Qwen2.5-0.5B',revision:'bae5ceaee026f0d0592858b2bd27645a06f19c42',bytes:490043908,cacheName:'fluent-read-information-highlight-model-v1'},
  'qwen3-0.6b':{id:'qwen3-0.6b',name:'Qwen3 0.6B',repository:'onnx-community/Qwen3-0.6B-ONNX',revision:'1e0a4a196ecabdf9a879664110574563d3f372d3',bytes:578918894,cacheName:'fluent-read-information-highlight-model-qwen3-0.6b-v1'},
};
const modelId=args['model-id']||'qwen2.5-0.5b';assert(Object.hasOwn(models,modelId),`Unsupported --model-id: ${modelId}`);
const model=models[modelId],otherModel=Object.values(models).find(value=>value.id!==modelId);
const modelUrlPrefix=`https://huggingface.co/${model.repository}/resolve/${model.revision}/`;
const downloadLabel=`下载模型（${(model.bytes/1_000_000).toFixed(0)} MB）`;
for(const field of ['extension-dir','playwright-root','artifacts-dir']) assert(args[field],`Missing --${field}`);
const downloadTimeout=Number(args['download-timeout-ms']||15*60*1000);
assert(Number.isFinite(downloadTimeout)&&downloadTimeout>=15000,'--download-timeout-ms must be at least 15000');
const operationTimeout=Number(args['operation-timeout-ms']||30000);
assert(Number.isFinite(operationTimeout)&&operationTimeout>=1000,'--operation-timeout-ms must be at least 1000');
const {chromium}=createRequire(path.join(args['playwright-root'],'information-highlight.cjs'))('playwright');
const helper=require(args['focus-safe-helper']||'./focus-safe-browser.cjs');
const extensionDir=path.resolve(args['extension-dir']);
const artifacts=path.resolve(args['artifacts-dir']);
const manifest=JSON.parse(fs.readFileSync(path.join(extensionDir,'manifest.json'),'utf8'));
fs.mkdirSync(artifacts,{recursive:true});
const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-information-highlight-'));
const report={ok:false,extensionDir,profileDir,stages:[],surface:'options-continuous-smart-highlight-group',build:extensionDir.endsWith('-dev')?'development':'production',
  selectedModel:model,
  evidence:'real-extension-controlled-pages',cases:[],screenshots:[],consoleErrors:[],persistenceCases:[],consoleWarnings:[],
  quickClose:false,crossPageSync:false,latestWriteWins:false,
  modelAcquisition:args['download-model']?'production-settings-download':args['model-dir']?'verified-local-artifact-import':'not-requested',
  unverified:['Firefox browser execution','reading-speed benefit','arbitrary-site compatibility','local model inference','product model download/pause/resume']};
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Information highlighting fixture</title>
<style>body{margin:0;background:#fafaf7;color:#24312b;font:18px/1.8 system-ui}main{max-width:760px;margin:40px auto;padding:24px}p{margin:20px 0}a{color:inherit}pre{background:#eee}#excluded{position:fixed;right:10px;bottom:10px}</style></head>
<body><main><h1>浏览器本地语言模型与阅读辅助</h1>
<article id="article">${Array.from({length:240},(_,i)=>`<p data-paragraph="${i}">第 ${i+1} 段：浏览器<em>本地模型</em>分析正文，在 <a href="#source">阅读位置附近</a>优先计算。信息意外度与关键词是不同的方法；高亮并不证明内容正确。只有满足条件时才缓存结果，不能上传原文。Unicode 包含 é、👩🏽‍💻 和中文标点。</p>`).join('')}</article>
<div id="shadow-anchor"></div><pre id="code">const unexpectedWords = ['local model', '关键词'];</pre>
<div contenteditable="true" id="editor">此处是可编辑的正文，不能参与评分。</div>
<button id="excluded">浏览器模型与关键词按钮</button><p hidden>隐藏的模型文字</p></main>
<script>const root=document.querySelector('#shadow-anchor').attachShadow({mode:'open'});root.innerHTML='<p style="font:18px/1.8 system-ui">开放 Shadow DOM 的本地语言模型正文需要正确定位原文与意外度词语。</p>';</script></body></html>`;
const modelManifest=args['model-dir']?JSON.parse(fs.readFileSync(path.join(args['model-dir'],'manifest.json'),'utf8')):[];
if(modelManifest.length){
  assert.equal(modelManifest.length,6,'A verified local model must provide the six production artifacts');
  assert(modelManifest.every(file=>file.url===`${modelUrlPrefix}${file.path}`&&/^[a-f0-9]{64}$/u.test(file.sha256)),'Local artifact manifest must match the selected pinned model');
  assert.equal(modelManifest.reduce((sum,file)=>sum+file.size,0),model.bytes,'Local artifact sizes must match the selected production model');
}
const server=http.createServer((req,res)=>{
  const model=modelManifest.find(file=>req.url===`/models/${file.path}`);
  if(model){
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/octet-stream');
    const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
    const start=range?Number(range[1]):0,end=range?Math.min(Number(range[2]),model.size-1):model.size-1;
    res.statusCode=range?206:200;res.setHeader('Content-Length',end-start+1);
    if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${model.size}`);
    fs.createReadStream(path.join(args['model-dir'],model.path),{start,end}).pipe(res);return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);
});
const save=()=>fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function textRanges(page){return page.evaluate(()=>{
  const ranges=[];if(!CSS.highlights)return ranges;
  for(const [name,highlight]of CSS.highlights)if(name.includes('information'))
    for(const range of highlight)ranges.push({name,text:range.toString(),parent:range.startContainer.parentElement?.id||'',root:range.startContainer.getRootNode()===document?'document':'shadow'});
  return ranges;
});}
// 静态契约检查真实生产 Popup 入口及其本地模块图；不注入或替换浏览器 runtime API。
function popupSourceContract(){
  const repository=path.resolve(__dirname,'../..');
  const forbidden=/PopupInformationHighlight|createPopupInformationHighlight|informationHighlightActions|GET_INFORMATION_HIGHLIGHT_STATE|SET_INFORMATION_HIGHLIGHT_ENABLED|RETRY_INFORMATION_HIGHLIGHT|GET_INFORMATION_HIGHLIGHT_MODEL_STATUS|PREPARE_INFORMATION_HIGHLIGHT_MODEL|PAUSE_INFORMATION_HIGHLIGHT_MODEL|REMOVE_INFORMATION_HIGHLIGHT_MODEL|SCORE_INFORMATION_HIGHLIGHT/u;
  const sourceFiles=['src/app/popup/PopupApp.vue','src/app/popup/mount.ts','entrypoints/popup/main.ts'].map(relative=>{
    const source=fs.readFileSync(path.join(repository,relative),'utf8');assert(!forbidden.test(source),`Popup source still contains information highlighting: ${relative}`);
    return {path:relative,sha256:createHash('sha256').update(source).digest('hex')};
  });
  const htmlPath=path.join(extensionDir,manifest.action.default_popup),html=fs.readFileSync(htmlPath,'utf8');
  const pending=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gu)].map(match=>path.resolve(path.dirname(htmlPath),match[1].replace(/^\//u,'')));
  const seen=new Set(),productionFiles=[];
  while(pending.length){
    const file=pending.pop();if(seen.has(file))continue;seen.add(file);
    assert(file.startsWith(extensionDir+path.sep),'Popup module reference must stay inside this build');
    const source=fs.readFileSync(file,'utf8');assert(!forbidden.test(source),`Production Popup module still contains feature messages: ${path.relative(extensionDir,file)}`);
    productionFiles.push({path:path.relative(extensionDir,file),sha256:createHash('sha256').update(source).digest('hex')});
    const imports=[...source.matchAll(/\b(?:import|export)\s*(?:(?:\{[^}]*\}|\*[\w\s]*|\w+)\s*from\s*)?["']([^"']+)["']/gu),...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu)];
    for(const match of imports){const specifier=match[1].split('?')[0];if(!specifier.endsWith('.js'))continue;
      if(specifier.startsWith('.'))pending.push(path.resolve(path.dirname(file),specifier));
      else if(specifier.startsWith('/'))pending.push(path.resolve(extensionDir,specifier.slice(1)));
    }
  }
  assert(productionFiles.length>0,'Production Popup script graph must be inspected');
  return {evidence:'current-popup-source-and-production-static-js-graph; real DOM is checked separately; no runtime message interception',sourceFiles,productionFiles};
}
(async()=>{
  let session,primaryError,focusTimer,focusError,focusMonitor,browserPid,fatalError,cleanupStarted=false;
  let rejectFatal;const fatal=new Promise((_,reject)=>{rejectFatal=reject;});void fatal.catch(()=>{});
  function checkpoint(name,state,extra={}){
    const entry={name,state,at:Date.now(),...extra};report.stage=entry;report.stages.push(entry);
    if(focusMonitor)report.focusEvents=[...focusMonitor.events];save();
  }
  function failImmediately(error,kind){
    fatalError||=error;primaryError||=fatalError;report.ok=false;report.error=primaryError.stack||String(primaryError);
    report[`${kind}Error`]=error.stack||String(error);if(focusMonitor)report.focusEvents=[...focusMonitor.events];save();rejectFatal(fatalError);
    void session?.close().catch(closeError=>{report.asynchronousCloseError=String(closeError);save();});
  }
  async function step(name,action,milliseconds=operationTimeout,{ignoreFatal=false}={}){
    checkpoint(name,'before');let timer;
    try{
      const operation=Promise.resolve().then(action),timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
        const error=new Error(`Runner stage timed out after ${milliseconds}ms: ${name}`);error.code='INFORMATION_HIGHLIGHT_TEST_TIMEOUT';reject(error);
      },milliseconds);});
      const result=await Promise.race(ignoreFatal?[operation,timeout]:[operation,timeout,fatal]);checkpoint(name,'after');return result;
    }catch(error){
      primaryError||=fatalError||error;report.ok=false;report.error=primaryError.stack||String(primaryError);checkpoint(name,'failed',{error:error.stack||String(error)});throw error;
    }finally{clearTimeout(timer);}
  }
  const shot=(page,name)=>step(`screenshot:${name}`,async()=>{
    const file=`${name}.png`;await page.screenshot({path:path.join(artifacts,file),caret:'initial',timeout:15000});report.screenshots.push(file);
  },20000);
  try{
    report.popupSourceContract=await step('popup-source-contract',()=>popupSourceContract());
    await step('fixture-server-listen',()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}));
    const fixtureUrl=`http://127.0.0.1:${server.address().port}/article`;
    focusMonitor=helper.startFocusEventMonitor({onEvent(event){
      report.focusEvents=[...focusMonitor.events];save();
      if(browserPid&&event.pid===browserPid){focusError=new Error('Owned browser activated during continuous native focus observation');failImmediately(focusError,'focus');}
    },onError(error){focusError=error;failImmediately(error,'focusObserver');}});
    report.focusObserver=await step('native-focus-observer-ready',()=>focusMonitor.ready,35000);
    const launching=helper.launchFocusSafePersistentContext({chromium,profileDir,background:true,headless:false,displayTarget:'secondary',
      browserPath:args['browser-path']||'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',viewport:{width:1440,height:1000},timeout:30000,
      browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
    // 过晚的 helper 返回只关闭其本次、已由 shared guard 确认的 session；不凭 PID 猜测或清理别的浏览器。
    void launching.then(async late=>{if(!session&&(cleanupStarted||fatalError)){guardBrowserClose(late,profileDir);try{await late.close();report.lateLaunchCleanup='guarded-close-complete';}catch(error){report.lateLaunchCleanupError=String(error);}save();}},()=>{});
    session=await step('browser-launch',()=>launching,90000);guardBrowserClose(session,profileDir);
    Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});
    assert.equal(session.launchMode,'macos-background-cdp');assert.equal(session.focusPolicy,'launchservices-no-foreground');
    assert.equal(session.windowPlacement.mode,'background-visible-no-focus');assert.equal(session.windowPlacement.browserFrontmost,false);
    browserPid=await step('browser-owned-pid',()=>getGuardedBrowserPid(session));report.browserPid=browserPid;report.focusSamples=[];
    if(focusMonitor.events.some(event=>event.pid===browserPid)){focusError=new Error('Owned browser activated during launch');failImmediately(focusError,'focus');throw focusError;}
    const context=session.context;context.setDefaultTimeout(15000);
    context.browser().on('disconnected',()=>{
      report.browserDisconnected={at:Date.now(),expectedCleanup:cleanupStarted};save();
      if(!cleanupStarted)failImmediately(new Error('Owned browser disconnected before validation completed'),'browserDisconnect');
    });
    const checkFocus=async()=>{
      const front=await helper.queryMacFrontmostApplication();report.focusSamples.push({at:Date.now(),pid:front?.pid,name:front?.name});
      if(focusMonitor.error)throw focusMonitor.error;if(focusError)throw focusError;
      if(!front||front.pid===browserPid){focusError=new Error('Focus protection stopped the owned test browser');throw focusError;}
    };
    await step('initial-focus-check',()=>checkFocus());
    for(let i=0;i<5;i++){await delay(200);await step(`launch-stable-focus:${i}`,()=>checkFocus());}
    let checking=false;
    focusTimer=setInterval(()=>{if(checking)return;checking=true;void checkFocus().catch(error=>{focusError||=error;failImmediately(error,'focus');}).finally(()=>{checking=false;});},500);
    let networkStage='page-and-ui-tests';const networkRequests=new WeakMap();
    report.networkObservation={scope:'Playwright browser-context HTTP request/response events, including service-worker requests when exposed; offscreen and dedicated-worker coverage is not guaranteed',requests:[],truncated:0,errors:[]};
    context.on('request',request=>{try{
      const url=new URL(request.url());if(!['http:','https:'].includes(url.protocol))return;
      if(report.networkObservation.requests.length>=500){report.networkObservation.truncated++;return;}
      const record={at:Date.now(),stage:networkStage,url:`${url.origin}${url.pathname}`,method:request.method(),range:request.headers().range||null,
        serviceWorker:typeof request.serviceWorker==='function'?Boolean(request.serviceWorker()):'not-exposed'};
      networkRequests.set(request,record);report.networkObservation.requests.push(record);
    }catch(error){report.networkObservation.errors.push(String(error));}});
    context.on('response',response=>{try{const record=networkRequests.get(response.request());if(record){const headers=response.headers();Object.assign(record,{status:response.status(),contentLength:headers['content-length']||null,contentRange:headers['content-range']||null});}}catch(error){report.networkObservation.errors.push(String(error));}});
    context.on('requestfailed',request=>{const record=networkRequests.get(request);if(record)record.failure=request.failure()?.errorText||'unknown';});
    let bootstrap=context.pages().find(page=>page.url().startsWith('about:blank#fluentread-background-'));
    function observePage(page){
      if(page.__informationHighlightObserved)return;page.__informationHighlightObserved=true;
      page.on('pageerror',error=>{report.consoleErrors.push({surface:page.url(),message:error.message});save();});
      page.on('console',message=>{if(message.type()==='warning'&&page.url().startsWith('chrome-extension://'))report.consoleWarnings.push({surface:page.url(),message:message.text()});});
    }
    const navigate=(page,url,name)=>step(`navigate:${name}`,()=>page.goto(url,{timeout:30000}),35000);
    const activate=(page,name)=>step(`activate-owned-tab:${name}`,async()=>{await helper.activateExtensionTabWithoutForeground(context,page);await checkFocus();});
    const open=async(url,name)=>{
      await step(`focus-before-open:${name}`,()=>checkFocus());
      const page=bootstrap||await step(`create-target:${name}`,()=>helper.newPageWithoutForeground(context,30000),45000);bootstrap=null;observePage(page);
      await navigate(page,url,name);await step(`focus-after-open:${name}`,()=>checkFocus());return page;
    };
    const worker=await step('extension-worker',async()=>context.serviceWorkers().find(value=>value.url().startsWith('chrome-extension://'))||context.waitForEvent('serviceworker',{timeout:30000}));
    worker.on('console',message=>{if(message.type()==='error'){report.consoleErrors.push({surface:'worker',message:message.text()});save();}});
    const origin=`chrome-extension://${new URL(worker.url()).host}`,optionsUrl=`${origin}/${manifest.options_page||manifest.options_ui.page}#settings-translation`,popupUrl=`${origin}/${manifest.action.default_popup}`;
    let control=await open(optionsUrl,'options');await activate(control,'options');
    const waitSettings=page=>step('settings-group-ready',()=>page.locator('#information-highlight-settings').waitFor());
    const highlightTitle=(page,language)=>step(`smart-highlight-title:${language}`,async()=>{
      const expected=language==='en-US'?'Smart Highlighting':'智能高亮';
      const title=page.locator('#information-highlight-settings').getByRole('heading',{name:expected,exact:true});await title.waitFor();
      assert.equal((await title.innerText()).trim(),expected);
      assert.equal((await page.locator('[data-settings-anchor-link="information-highlight"]').innerText()).trim(),expected);
      if(language==='zh-CN')assert.equal((await page.locator('#information-highlight-settings > .settings-group-heading > p').innerText()).trim(),'自动突出正文中的词语，让阅读更有侧重。');
      return {language,title:expected};
    });
    const anchorSnapshot=(page,id)=>page.evaluate(id=>{
      const content=document.querySelector('.settings-card'),target=document.querySelector(`[data-settings-panel="${id}"]`),contentRect=content.getBoundingClientRect(),targetRect=target.getBoundingClientRect();
      return {anchor:id,scrollTop:content.scrollTop,content:contentRect.toJSON(),target:targetRect.toJSON(),relativeTop:targetRect.top-contentRect.top,
        panels:['reading','information-highlight','hover','input'].map(name=>{const element=document.querySelector(`[data-settings-panel="${name}"]`),rect=element?.getBoundingClientRect(),style=element&&getComputedStyle(element);return{name,inDOM:Boolean(element?.isConnected),cssVisible:Boolean(rect&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&element.getClientRects().length),height:rect?.height};})};
    },id);
    const waitAnchor=(page,id)=>page.waitForFunction(id=>{
      const content=document.querySelector('.settings-card'),target=document.querySelector(`[data-settings-panel="${id}"]`),button=document.querySelector(`[data-settings-anchor-link="${id}"]`);
      if(!content||!target||button?.getAttribute('aria-current')!=='location')return false;
      const relativeTop=target.getBoundingClientRect().top-content.getBoundingClientRect().top;
      return relativeTop>=-3&&relativeTop<=24;
    },id,{timeout:7000});
    const clickAnchor=(page,id)=>step(`continuous-settings-anchor:${id}`,async()=>{
      const button=page.locator(`[data-settings-anchor-link="${id}"]`);await button.waitFor();const before=await anchorSnapshot(page,id);await button.click();await waitAnchor(page,id);
      const after=await anchorSnapshot(page,id);assert(after.panels.every(panel=>panel.inDOM&&panel.cssVisible),'Anchor navigation must keep reading, Smart Highlighting, hover and input groups CSS-visible in the continuous page');
      return {id,before,after,scrollDelta:after.scrollTop-before.scrollTop,selection:'native-anchor-click'};
    });
    const openHighlightSettings=(page,{verifyReading=false}={})=>step('open-smart-highlight-anchor-in-continuous-settings',async()=>{
      const readingAnchor=page.locator('[data-settings-anchor-link="reading"]'),smartAnchor=page.locator('[data-settings-anchor-link="information-highlight"]');
      await readingAnchor.waitFor();await smartAnchor.waitFor();await waitSettings(page);
      for(const id of ['reading','information-highlight','hover','input'])await page.locator(`[data-settings-panel="${id}"]`).waitFor();
      if(verifyReading){
        const readingNavigation=await clickAnchor(page,'reading');const readingPanel=page.locator('[data-settings-panel="reading"]');await readingPanel.waitFor();
        const bilingualSwitch=readingPanel.locator('#translation-sentence-highlight .el-switch');await bilingualSwitch.waitFor();
        const bilingualInput=bilingualSwitch.locator('input[role="switch"]');await bilingualInput.waitFor({state:'attached'});
        assert.equal(await bilingualInput.getAttribute('aria-label'),'双语逐句高亮');
        const checked=await bilingualInput.getAttribute('aria-checked');assert(['true','false'].includes(checked));assert.equal(await bilingualInput.isChecked(),checked==='true');
        assert.equal(await readingPanel.locator('#information-highlight-settings,[data-information-highlight-mode-select],[data-testid="information-highlight-model-card"]').count(),0,'Bilingual reading panel must contain no Smart Highlighting feature');
        report.cases.push({id:'bilingual-reading-group-excludes-smart-highlighting',panel:'reading',navigation:readingNavigation,bilingualSwitch:{visibleWrapper:true,attachedRoleInput:true,ariaLabel:'双语逐句高亮',checked}});
        for(const id of ['hover','input'])report.cases.push({id:`continuous-settings-anchor-${id}`,navigation:await clickAnchor(page,id)});
      }
      const navigation=await clickAnchor(page,'information-highlight');const smartPanel=page.locator('[data-settings-panel="information-highlight"]');await smartPanel.waitFor();
      assert.equal(await smartAnchor.getAttribute('aria-current'),'location');assert.equal(await readingAnchor.getAttribute('aria-current'),null);
      assert.equal(await smartPanel.locator('#information-highlight-settings').count(),1);
      assert.equal(await smartPanel.locator('#translation-sentence-highlight,[data-testid="sentence-highlight-grouping-hint"],[data-testid="open-sentence-highlight-styles"],.reading-assistance-settings').count(),0,'Smart Highlighting panel must contain no bilingual controls');
      if(verifyReading){
        assert(Math.abs(navigation.scrollDelta)>5,'Smart Highlighting anchor must move the existing content scroller from the input group');
        report.cases.push({id:'smart-highlighting-independent-group-in-continuous-page',section:'settings-translation',panel:'information-highlight',navigation});
        await clickAnchor(page,'reading');const before=await anchorSnapshot(page,'information-highlight');
        const search=page.locator('.search-box input[type="search"]');await search.fill('智能高亮');
        const results=page.locator('.search-results button').filter({has:page.locator('strong').filter({hasText:/^智能高亮$/u})});await results.first().waitFor();const matchingResults=await results.count();
        await results.first().click();await page.locator('.search-results').waitFor({state:'hidden'});await waitAnchor(page,'information-highlight');
        const after=await anchorSnapshot(page,'information-highlight');assert(after.panels.every(panel=>panel.inDOM&&panel.cssVisible));assert(after.scrollTop-before.scrollTop>5);
        report.cases.push({id:'smart-highlight-search-reveals-anchor-without-hiding-neighbours',matchingResults,selection:'native-search-result-click',before,after,scrollDelta:after.scrollTop-before.scrollTop});
      }
    });
    // 真实 hover、Tab/Shift+Tab 和 click，不注入 focus/visibility，也不替换 Tooltip 或 runtime API。
    const helpTags=async(page,language,{interactions=true,screenshot}={})=>step(`smart-highlight-help-tags:${language}:${interactions?'interactions':'layout'}`,async()=>{
      const names=['keywords','surprisal','reading'],group=page.locator('#information-highlight-settings'),title=group.locator('h2');
      const tags=names.map(name=>group.locator(`button[data-information-highlight-tag="${name}"]`));
      const visiblePopper=page.locator('.fluentread-information-highlight-tag-popper[role="tooltip"]:visible');
      const hidden=()=>page.locator('.fluentread-information-highlight-tag-popper[role="tooltip"]').waitFor({state:'hidden',timeout:5000});
      const outside=async()=>{await title.click();await hidden();};
      const tooltip=async(index,via)=>{
        await visiblePopper.waitFor({timeout:5000});assert.equal(await visiblePopper.count(),1);await delay(300);
        const describedBy=await tags[index].getAttribute('aria-describedby');assert(describedBy,'Help tag must describe its tooltip');
        assert(describedBy.split(/\s+/u).includes(await visiblePopper.getAttribute('id')));
        const metrics=await visiblePopper.evaluate(element=>({text:element.innerText.trim(),rect:element.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
        assert(metrics.text.length>15,'Tooltip must explain the principle or use, rather than repeat its tag');
        assert(metrics.rect.width>0&&metrics.rect.height>0&&metrics.rect.x>=-1&&metrics.rect.y>=-1&&metrics.rect.right<=metrics.width+1&&metrics.rect.bottom<=metrics.height+1,'Help tooltip must fit the viewport');
        return {tag:names[index],via,...metrics};
      };
      await title.scrollIntoViewIfNeeded();await outside();
      const viewportWidth=await page.evaluate(()=>innerWidth);
      const layout=[];for(const [index,tag]of tags.entries()){
        await tag.waitFor();assert(await tag.isEnabled());const rect=await tag.boundingBox();assert(rect&&rect.width>0&&rect.x>=0&&rect.x+rect.width<=viewportWidth+1);
        layout.push({tag:names[index],rect,label:(await tag.innerText()).trim()});
      }
      const evidence=[];
      if(interactions){
        for(let index=0;index<tags.length;index++){await tags[index].hover();evidence.push(await tooltip(index,'pointer-hover'));await title.hover();await hidden();}
        // 点击末标签建立真实焦点，随后通过原生 Shift+Tab / Tab 进入三个标签。
        await tags[2].click();await page.keyboard.press('Escape');await hidden();await title.hover();
        for(const [index,key]of [[1,'Shift+Tab'],[0,'Shift+Tab'],[1,'Tab'],[2,'Tab']]){
          await page.keyboard.press(key);assert(await tags[index].evaluate(element=>document.activeElement===element&&element.matches(':focus-visible')),'Help tag must receive visible keyboard focus');
          evidence.push(await tooltip(index,`keyboard-${key}`));await page.keyboard.press('Escape');await hidden();
          assert(await tags[index].evaluate(element=>document.activeElement===element),'Escape must dismiss help without moving focus');
        }
        await outside();
        for(let index=0;index<tags.length;index++){
          await tags[index].click();evidence.push(await tooltip(index,'native-click'));await page.keyboard.press('Escape');await hidden();
          await title.hover();await tags[index].click();await tooltip(index,'native-click-before-outside');await outside();
        }
      }
      await tags[0].hover();const narrowTooltip=await tooltip(0,'layout-hover');if(screenshot)await shot(page,screenshot);await title.hover();await hidden();
      report.cases.push({id:`smart-highlight-help-tags-${language}-${viewportWidth}`,language,viewportWidth,layout,interactions:evidence,tooltip:narrowTooltip});
    },45000);
    await step('translation-anchors-ready',()=>control.locator('[data-settings-anchor-link="reading"]').waitFor());
    await step('fixture-config',()=>support.patchStoredConfig(control,{on:true,disableFloatingBall:false,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',informationHighlight:{enabled:false,hotkey:'Alt+H',hotkeyEnabled:true,mode:'keywords',model:modelId,density:'medium',color:'amber',style:'background',intensity:'standard'}}));
    const patchConfig=patch=>step('fixture-config-patch',()=>support.patchStoredConfig(control,patch));
    await openHighlightSettings(control,{verifyReading:true});report.cases.push({id:'smart-highlight-exact-title-zh',...await highlightTitle(control,'zh-CN')});
    await helpTags(control,'zh-CN',{screenshot:'smart-highlight-help-zh'});
    await patchConfig({uiLanguage:'en-US'});report.cases.push({id:'smart-highlight-exact-title-en',...await highlightTitle(control,'en-US')});
    await helpTags(control,'en-US',{screenshot:'smart-highlight-help-en'});await patchConfig({uiLanguage:'zh-CN'});await highlightTitle(control,'zh-CN');
    const page=await open(fixtureUrl,'article');await activate(page,'article');
    await step('article-content-ready',()=>page.waitForFunction(()=>Boolean(document.querySelector('#fluent-read-floating-ball-container')),null,{timeout:30000}));
    const tabId=await step('article-tab-id',()=>control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,fixtureUrl));assert(Number.isInteger(tabId));
    const send=(type,extra={})=>step(`article-rpc:${type}`,()=>control.evaluate(async({tabId,type,extra})=>chrome.tabs.sendMessage(tabId,{type,...extra}),{tabId,type,extra}));
    const initial=await send('GET_INFORMATION_HIGHLIGHT_STATE');assert.equal((initial.state||initial).enabled,false);
    const paintedNow=()=>page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('fluentread-information-highlight')).reduce((total,[,paint])=>total+paint.size,0));
    await step('hotkey-toggle-on',()=>page.keyboard.press('Alt+KeyH'));
    await step('hotkey-paints-current-page',()=>page.waitForFunction(()=>[...CSS.highlights].some(([name,paint])=>name.startsWith('fluentread-information-highlight')&&paint.size>0),null,{timeout:30000}));
    const hotkeyRanges=await step('hotkey-range-count',paintedNow);assert(hotkeyRanges>0);
    const noticeText=()=>page.evaluate(()=>document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.textContent||'');
    await step('hotkey-on-notice',()=>page.waitForFunction(()=>(document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.textContent||'').includes('智能高亮已开启'),null,{timeout:15000}));
    assert((await step('hotkey-notice-keeps-paint',paintedNow))>=hotkeyRanges,'The page notice must not disturb painted ranges');
    const hotkeyStored=await step('hotkey-does-not-save-switch',()=>support.readStoredConfig(control));assert.equal(hotkeyStored.informationHighlight.enabled,false);assert.equal(hotkeyStored.informationHighlight.hotkey,'Alt+H');
    await step('hotkey-toggle-off',()=>page.keyboard.press('Alt+KeyH'));
    await step('hotkey-clears-current-page',()=>page.waitForFunction(()=>![...CSS.highlights.keys()].some(name=>name.startsWith('fluentread-information-highlight')),null,{timeout:30000}));
    await step('hotkey-off-notice',()=>page.waitForFunction(()=>(document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.textContent||'').includes('智能高亮已关闭'),null,{timeout:15000}));
    // 模型尚未下载时用快捷键开启：页面给出明确提示，而不是毫无反应。
    await step('model-mode-before-download',()=>support.patchStoredConfig(control,{informationHighlight:{enabled:false,hotkey:'Alt+H',hotkeyEnabled:true,mode:'surprisal-local',model:modelId,density:'medium',color:'amber',style:'background',intensity:'standard'}}));
    await delay(600);await step('hotkey-on-without-model',()=>page.keyboard.press('Alt+KeyH'));
    await step('hotkey-model-not-ready-notice',()=>page.waitForFunction(()=>(document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.textContent||'').includes('本地模型尚未下载'),null,{timeout:30000}));
    const missingModelNotice=await step('hotkey-model-not-ready-text',noticeText);
    // 没有模型时本页改用关键词方式，读者仍然得到高亮。
    await step('hotkey-without-model-keyword-fallback',()=>page.waitForFunction(()=>[...CSS.highlights].some(([name,paint])=>name.startsWith('fluentread-information-highlight')&&paint.size>0),null,{timeout:30000}));
    await step('hotkey-off-without-model',()=>page.keyboard.press('Alt+KeyH'));
    await step('keywords-mode-restored',()=>support.patchStoredConfig(control,{informationHighlight:{enabled:false,hotkey:'Alt+H',hotkeyEnabled:true,mode:'keywords',model:modelId,density:'medium',color:'amber',style:'background',intensity:'standard'}}));
    await delay(600);report.cases.push({id:'hotkey-without-downloaded-model-falls-back-to-keywords-with-notice',missingModelNotice});
    assert.equal(await step('hotkey-settings-row',()=>control.locator('#information-highlight-settings [data-information-highlight-hotkey]').innerText()),'Alt+H');
    const hotkeySwitch=control.locator('#information-highlight-settings [data-information-highlight-hotkey-enabled]').first();
    await step('hotkey-switch-off',async()=>{await hotkeySwitch.scrollIntoViewIfNeeded();await hotkeySwitch.click();});
    await step('hotkey-switch-off-stored',async()=>{for(const deadline=Date.now()+8000;;){if((await support.readStoredConfig(control)).informationHighlight.hotkeyEnabled===false)return;assert(Date.now()<deadline,'Shortcut switch was not persisted');await delay(100);}},12000);
    await delay(400);await step('hotkey-ignored-while-off',()=>page.keyboard.press('Alt+KeyH'));await delay(800);
    assert.equal(await step('hotkey-off-leaves-page-unpainted',paintedNow),0);
    await step('hotkey-switch-on',()=>hotkeySwitch.click());
    await step('hotkey-switch-on-stored',async()=>{for(const deadline=Date.now()+8000;;){const stored=(await support.readStoredConfig(control)).informationHighlight;if(stored.hotkeyEnabled===true&&stored.hotkey==='Alt+H')return;assert(Date.now()<deadline,'Shortcut switch was not restored');await delay(100);}},12000);
    report.cases.push({id:'hotkey-toggles-only-current-page-without-saving',switchOffIgnoresKey:true,hotkey:'Alt+H',hotkeyRanges,savedSwitch:false});
    const autoSwitch=control.locator('#information-highlight-settings [data-information-highlight-enabled]').first();
    const ownedPaint=()=>page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('fluentread-information-highlight')).reduce((total,[,paint])=>total+paint.size,0));
    await step('settings-auto-switch-on',async()=>{await autoSwitch.scrollIntoViewIfNeeded();await autoSwitch.click();});
    await step('auto-switch-paints-open-page',()=>page.waitForFunction(()=>[...CSS.highlights].some(([name,paint])=>name.startsWith('fluentread-information-highlight')&&paint.size>0),null,{timeout:30000}));
    assert.equal((await step('auto-switch-stored-on',()=>support.readStoredConfig(control))).informationHighlight.enabled,true);
    const autoState=await send('GET_INFORMATION_HIGHLIGHT_STATE');assert.equal((autoState.state||autoState).enabled,true);
    const autoRanges=await step('auto-switch-range-count',ownedPaint);assert(autoRanges>0);
    await step('auto-switch-reload-page',()=>page.reload({timeout:30000}),35000);
    await step('auto-switch-paints-after-reload',()=>page.waitForFunction(()=>[...CSS.highlights].some(([name,paint])=>name.startsWith('fluentread-information-highlight')&&paint.size>0),null,{timeout:30000}));
    const scrollEvidence=await step('auto-switch-scroll-keeps-paint',()=>page.evaluate(async()=>{
      const total=()=>[...CSS.highlights].filter(([name])=>name.startsWith('fluentread-information-highlight')).reduce((sum,[,paint])=>sum+paint.size,0);
      const before=total();let minimum=before,running=true;const sample=()=>{minimum=Math.min(minimum,total());if(running)requestAnimationFrame(sample);};sample();
      window.scrollBy(0,400);await new Promise(resolve=>setTimeout(resolve,900));window.scrollBy(0,-400);await new Promise(resolve=>setTimeout(resolve,900));running=false;
      return{before,minimum,after:total()};
    }));
    assert(scrollEvidence.before>0&&scrollEvidence.minimum>=scrollEvidence.before,'Scrolling must not clear paint that stays in the reading area');
    await step('settings-auto-switch-off',()=>autoSwitch.click());
    await step('auto-switch-clears-page',()=>page.waitForFunction(()=>![...CSS.highlights.keys()].some(name=>name.startsWith('fluentread-information-highlight')),null,{timeout:30000}));
    assert.equal((await step('auto-switch-stored-off',()=>support.readStoredConfig(control))).informationHighlight.enabled,false);
    await step('article-content-ready-after-reload',()=>page.waitForFunction(()=>Boolean(document.querySelector('#fluent-read-floating-ball-container')),null,{timeout:30000}));
    report.cases.push({id:'settings-switch-auto-highlights-web-page',autoRanges,scrollEvidence,reloadKeepsHighlight:true,offClearsEveryOwnedPaint:true});
    await step('article-source-snapshot',()=>page.evaluate(()=>{window.__highlightFixture={nodes:[...document.querySelectorAll('#article p,#article em,#article a')],html:document.querySelector('#article').innerHTML,text:document.querySelector('#article').textContent,rect:document.querySelector('#article').getBoundingClientRect().toJSON()};}));
    await send('SET_INFORMATION_HIGHLIGHT_ENABLED',{enabled:true});
    await step('keywords-paint',()=>page.waitForFunction(()=>CSS.highlights&&[...CSS.highlights].some(([name,highlight])=>name.includes('information')&&highlight.size>0),null,{timeout:30000}));
    let ranges=await step('keywords-ranges',()=>textRanges(page));assert(ranges.length>0);assert(ranges.every(range=>!['code','editor','excluded'].includes(range.parent)));
    const protection=await step('article-source-protection',()=>page.evaluate(()=>{const before=window.__highlightFixture,article=document.querySelector('#article');return{textSame:before.text===article.textContent,htmlSame:before.html===article.innerHTML,nodeIdentity:before.nodes.every(node=>node.isConnected),rect:article.getBoundingClientRect().toJSON(),before:before.rect};}));
    assert(protection.textSame&&protection.htmlSame&&protection.nodeIdentity);assert.deepEqual(protection.rect,protection.before);
    report.cases.push({id:'keywords-original-node-and-geometry-preservation',activation:'direct-tab-rpc-controlled-fixture',ranges:ranges.length,protection});
    await delay(500);
    report.nativePaint=await step('native-paint-snapshot',()=>page.evaluate(()=>({styles:[...document.querySelectorAll('[data-fr-information-highlight-style]')].map(style=>({text:style.textContent,rules:[...style.sheet.cssRules].map(rule=>rule.cssText)})),ranges:[...CSS.highlights.get('fluentread-information-highlight')].map(range=>({text:range.toString(),rect:range.getBoundingClientRect().toJSON()}))})));
    await shot(page,'keywords-page');await shot(page,'keywords-default-caret');
    assert((await step('paint-survives-screenshot',()=>textRanges(page))).length>0);report.cases.push({id:'excluded-editor-screenshot-does-not-clear-paint'});
    const second=await open(`${fixtureUrl}?second`,'second-article');await activate(second,'second-article');
    await step('second-content-ready',()=>second.waitForFunction(()=>Boolean(document.querySelector('#fluent-read-floating-ball-container'))));
    const secondId=await step('second-tab-id',()=>control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,`${fixtureUrl}?second`));
    const secondState=await step('second-disabled-state',()=>control.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'GET_INFORMATION_HIGHLIGHT_STATE'}),secondId));
    assert.equal((secondState.state||secondState).enabled,false);report.cases.push({id:'new-tab-does-not-inherit-enabled'});await shot(second,'disabled-page');
    const popup=await open(popupUrl,'ordinary-popup');
    for(const layout of [{width:400,language:'zh-CN',theme:'light',name:'popup-400-zh'},
      {width:320,language:'zh-CN',theme:'light',name:'popup-320-zh'},
      {width:400,language:'en-US',theme:'light',name:'popup-400-en'},
      {width:400,language:'en-US',theme:'dark',name:'popup-400-en-dark'}]){
      await patchConfig({uiLanguage:layout.language,theme:layout.theme});
      await step(`popup-size:${layout.name}`,()=>popup.setViewportSize({width:layout.width,height:600}));await navigate(popup,popupUrl,layout.name);await activate(popup,layout.name);
      await step(`popup-ready:${layout.name}`,()=>popup.locator('.popup-shell').waitFor());await delay(1100);
      const absence=await step(`popup-absence:${layout.name}`,()=>popup.evaluate(()=>({
        selectors:[...document.querySelectorAll('[data-popup-quick-feature="highlight"],[data-popup-feature="information-highlight"],[data-information-highlight-drawer],[data-information-highlight-enabled],[data-information-highlight-mode-select],[data-testid*="information-highlight"]')].map(element=>element.outerHTML),
        featureWords:/智能高亮|Smart Highlighting|信息高亮|Information highlight/iu.test(document.body.innerText),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        dark:document.documentElement.classList.contains('dark'),lang:document.documentElement.lang,visibility:document.visibilityState
      })));
      assert.equal(absence.selectors.length,0);assert.equal(absence.featureWords,false);assert(absence.scrollWidth<=layout.width+1);
      assert.equal(absence.dark,layout.theme==='dark');assert.equal(absence.visibility,'visible');
      report.cases.push({id:`${layout.name}-no-information-highlight`,absence,messageEvidence:'popup-source-contract-and-production-static-js-graph'});await shot(popup,layout.name);
    }
    await patchConfig({uiLanguage:'zh-CN',theme:'light'});await activate(control,'settings-preferences');
    const settingButton=async(selector,name,{click=true}={})=>step(`settings-control:${name}`,async()=>{
      const button=control.locator(`#information-highlight-settings ${selector}`);await button.waitFor();await button.scrollIntoViewIfNeeded();assert(await button.isEnabled());
      const metrics=await button.evaluate(element=>{const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return{rect:rect.toJSON(),viewport:{width:innerWidth,height:innerHeight},hit:hit===element||element.contains(hit),label:element.textContent.trim(),visibility:document.visibilityState};});
      assert(metrics.rect.width>0&&metrics.rect.height>0&&metrics.rect.x>=0&&metrics.rect.y>=0&&metrics.rect.right<=metrics.viewport.width+1&&metrics.rect.bottom<=metrics.viewport.height+1&&metrics.hit&&metrics.visibility==='visible','Settings control must be visible and clickable after normal scrolling');
      if(click)await control.mouse.click(metrics.rect.x+metrics.rect.width/2,metrics.rect.y+metrics.rect.height/2);return metrics;
    });
    const paletteIds=['rose','amber','mint','blue','violet','slate'];
    assert.equal(await step('settings-six-palette-cards',()=>control.locator('#information-highlight-settings [data-information-highlight-color]').count()),paletteIds.length);
    for(const color of paletteIds){
      const metrics=await settingButton(`[data-information-highlight-color="${color}"]`,`palette-${color}`);
      const evidence=await step(`selected-palette-evidence:${color}`,()=>control.locator(`[data-information-highlight-color="${color}"]`).evaluate(element=>({
        selected:element.getAttribute('aria-pressed'),ramp:[...element.querySelectorAll('[data-information-highlight-palette-sample]')].map(sample=>getComputedStyle(sample).backgroundColor)
      })));
      assert.equal(evidence.selected,'true');assert(evidence.ramp.length>=5,'Palette card must show a visible multi-level ramp');assert(new Set(evidence.ramp).size>=3,'Palette samples must show varying intensity');
      assert.equal(await step(`only-one-palette-selected:${color}`,()=>control.locator('#information-highlight-settings [data-information-highlight-color][aria-pressed="true"]').count()),1);
      await step(`palette-stored:${color}`,async()=>{for(const deadline=Date.now()+8000;;){const stored=(await support.readStoredConfig(control)).informationHighlight.color;if(stored===color)return;assert(Date.now()<deadline,`Palette was not persisted: ${stored}`);await delay(100);}},12000);
      report.cases.push({id:`native-settings-palette-${color}`,color,metrics,...evidence});
    }
    await settingButton('[data-information-highlight-color="rose"]','heatmap-rose');
    await settingButton('[data-information-highlight-density="high"]','heatmap-density-high');
    await settingButton('[data-information-highlight-style="heatmap"]','heatmap-style');
    await step('settings-reload-after-heatmap',()=>control.reload({timeout:30000}),35000);await openHighlightSettings(control);
    for(const [selector,value]of [['color','rose'],['density','high'],['style','heatmap']])assert.equal(await step(`heatmap-preference-restored:${selector}`,()=>control.locator(`[data-information-highlight-${selector}="${value}"]`).getAttribute('aria-pressed')),'true');
    const heatmapConfig=await step('heatmap-cross-page-config',()=>support.readStoredConfig(popup));
    assert.equal(heatmapConfig.informationHighlight.color,'rose');assert.equal(heatmapConfig.informationHighlight.density,'high');assert.equal(heatmapConfig.informationHighlight.style,'heatmap');
    report.cases.push({id:'native-settings-heatmap-persists-after-reload',preferences:heatmapConfig.informationHighlight,crossPageSync:true});
    await step('article-multiple-heatmap-buckets',()=>page.waitForFunction(()=>CSS.highlights&&[...CSS.highlights].filter(([name,paint])=>name.startsWith('fluentread-information-highlight-')&&paint.size>0).length>=3,null,{timeout:30000}));
    const heatmap=await step('article-heatmap-native-evidence',()=>page.evaluate(()=>{
      const buckets=[...CSS.highlights].filter(([name,paint])=>name.startsWith('fluentread-information-highlight-')&&paint.size>0).map(([name,paint])=>({name,size:paint.size,text:[...paint].map(range=>range.toString())}));
      const rules=[...document.querySelectorAll('[data-fr-information-highlight-style]')].flatMap(style=>[...style.sheet.cssRules]).filter(rule=>rule.selectorText?.startsWith('::highlight(fluentread-information-highlight-')).map(rule=>({selector:rule.selectorText,color:rule.style.backgroundColor}));
      const before=window.__highlightFixture,article=document.querySelector('#article');
      return{buckets,rules,rangeCount:buckets.reduce((total,bucket)=>total+bucket.size,0),protection:{textSame:before.text===article.textContent,htmlSame:before.html===article.innerHTML,nodeIdentity:before.nodes.every(node=>node.isConnected),rect:article.getBoundingClientRect().toJSON(),before:before.rect}};
    }));
    assert(heatmap.buckets.length>=3);assert(heatmap.rangeCount>0&&heatmap.rangeCount<=4096);assert(new Set(heatmap.rules.map(rule=>rule.color)).size>=3);
    const alphas=heatmap.rules.map(rule=>Number(/,\s*([\d.]+)\)$/u.exec(rule.color)?.[1])).filter(Number.isFinite);
    assert(alphas.length>=3&&alphas.every((alpha,index)=>index===0||alpha>alphas[index-1]),'Heatmap CSS levels must increase in opacity');
    assert(heatmap.protection.textSame&&heatmap.protection.htmlSame&&heatmap.protection.nodeIdentity);assert.deepEqual(heatmap.protection.rect,heatmap.protection.before);
    report.cases.push({id:'native-heatmap-multiple-intensities-and-original-page-preservation',...heatmap});await shot(page,'heatmap-rose-page');
    const heatRuleAlphas=()=>page.evaluate(()=>[...document.querySelectorAll('[data-fr-information-highlight-style]')].flatMap(style=>[...style.sheet.cssRules]).map(rule=>rule.style.backgroundColor).filter(Boolean));
    const intensityEvidence={};
    for(const intensity of ['soft','strong','standard']){
      const rangesBefore=await step(`intensity-ranges-before:${intensity}`,()=>page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('fluentread-information-highlight')).flatMap(([,paint])=>[...paint]).length));
      await settingButton(`[data-information-highlight-intensity="${intensity}"]`,`intensity-${intensity}`);
      await step(`intensity-stored:${intensity}`,async()=>{for(const deadline=Date.now()+8000;;){const stored=(await support.readStoredConfig(control)).informationHighlight.intensity;if(stored===intensity)return;assert(Date.now()<deadline,`Colour intensity was not persisted: ${stored}`);await delay(100);}},12000);
      const expected={soft:'0.3',standard:'0.5',strong:'0.8'}[intensity];
      await step(`intensity-page-rule:${intensity}`,()=>page.waitForFunction(alpha=>[...document.querySelectorAll('[data-fr-information-highlight-style]')].some(style=>[...style.sheet.cssRules].some(rule=>rule.style.backgroundColor.replace(/\s/g,'').endsWith(`,${alpha})`))),expected,{timeout:15000}));
      const rangesAfter=await step(`intensity-ranges-after:${intensity}`,()=>page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('fluentread-information-highlight')).flatMap(([,paint])=>[...paint]).length));
      assert.equal(rangesAfter,rangesBefore,'Changing colour intensity must restyle existing ranges without repainting');
      intensityEvidence[intensity]={rules:await step(`intensity-rules:${intensity}`,heatRuleAlphas),ranges:rangesAfter};
    }
    report.cases.push({id:'native-settings-colour-intensity-restyles-open-page',intensityEvidence});
    await settingButton('[data-information-highlight-color="mint"]','mint-quick-close');
    await step('settings-close-after-color',()=>control.close());
    // 真关闭 Options 后重用已经存在的第二正文页签，避免为“重开”新增 CDP Target。
    control=second;await navigate(control,optionsUrl,'reopen-settings-after-color');await activate(control,'reopened-settings');await openHighlightSettings(control);
    assert.equal(await step('reopened-mint-selected',()=>control.locator('[data-information-highlight-color="mint"]').getAttribute('aria-pressed')),'true');
    report.quickClose=true;report.persistenceCases.push({id:'settings-color-quick-close-reopen',value:'mint',reusedTarget:true});
    await settingButton('[data-information-highlight-color="amber"]','amber');await settingButton('[data-information-highlight-color="blue"]','blue-latest-write');
    await settingButton('[data-information-highlight-density="high"]','density-high');await settingButton('[data-information-highlight-style="underline"]','style-underline');
    await step('settings-reload-after-preferences',()=>control.reload({timeout:30000}),35000);await openHighlightSettings(control);
    for(const [selector,value]of [['color','blue'],['density','high'],['style','underline']])assert.equal(await step(`preference-restored:${selector}`,()=>control.locator(`[data-information-highlight-${selector}="${value}"]`).getAttribute('aria-pressed')),'true');
    const crossPage=await step('preferences-cross-page-config',()=>support.readStoredConfig(popup));assert.equal(crossPage.informationHighlight.color,'blue');
    report.latestWriteWins=true;report.crossPageSync=true;report.persistenceCases.push({id:'settings-latest-write-reload-and-cross-page-sync',color:'blue',density:'high',style:'underline'});
    for(const width of [1440,820,390]){
      await step(`settings-layout-size:${width}`,()=>control.setViewportSize({width,height:1000}));await step(`settings-layout-scroll:${width}`,()=>control.locator('#information-highlight-settings').scrollIntoViewIfNeeded());
      const metrics=await step(`settings-layout-metrics:${width}`,()=>control.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})));
      assert(metrics.scrollWidth<=width+1);assert(metrics.scrollHeight<=metrics.height+1);report.cases.push({id:`settings-layout-${width}`,metrics});await shot(control,`settings-${width}`);
      if(width===390){await helpTags(control,'zh-CN',{interactions:false,screenshot:'smart-highlight-help-390-zh'});await patchConfig({uiLanguage:'en-US',theme:'dark'});await highlightTitle(control,'en-US');await helpTags(control,'en-US',{interactions:false,screenshot:'smart-highlight-help-390-en-dark'});await patchConfig({uiLanguage:'zh-CN',theme:'light'});await highlightTitle(control,'zh-CN');}
    }
    await step('restore-settings-size',()=>control.setViewportSize({width:1440,height:1000}));
    await activate(page,'dynamic-article');
    await step('replace-article-text',()=>page.evaluate(()=>{const paragraph=document.querySelector('[data-paragraph="0"]'),clone=paragraph.cloneNode(true);paragraph.replaceWith(clone);clone.firstChild.textContent='动态更新后的技术主题：浏览器本地语言模型需要取消迟到结果。';}));
    await delay(1000);ranges=await step('dynamic-ranges',()=>textRanges(page));assert(ranges.every(range=>!range.text.includes('第 1 段：')));report.cases.push({id:'dynamic-replaced-text-snapshot',ranges:ranges.length});
    await step('article-scroll-bottom',()=>page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)));await delay(1200);
    const bottom=await send('GET_INFORMATION_HIGHLIGHT_STATE');report.cases.push({id:'long-page-scroll',state:bottom.state||bottom,ranges:(await step('bottom-ranges',()=>textRanges(page))).length});
    await send('SET_INFORMATION_HIGHLIGHT_ENABLED',{enabled:false});assert.equal((await step('disabled-ranges',()=>textRanges(page))).length,0);
    await delay(500);assert.equal((await step('disabled-stable-ranges',()=>textRanges(page))).length,0);report.cases.push({id:'disable-clears-and-does-not-repaint'});
    await send('SET_INFORMATION_HIGHLIGHT_ENABLED',{enabled:true});await send('SET_INFORMATION_HIGHLIGHT_ENABLED',{enabled:false});await delay(500);
    assert.equal((await step('rapid-toggle-ranges',()=>textRanges(page))).length,0);report.cases.push({id:'rapid-enable-disable'});
    await activate(control,'settings-mode');
    const chooseMode=mode=>step(`settings-mode:${mode}`,async()=>{
      const selector=control.locator('#information-highlight-settings [data-information-highlight-mode-select]');await selector.scrollIntoViewIfNeeded();assert((await selector.boundingBox()).height>20);
      await selector.click();await control.locator(`[data-information-highlight-mode="${mode}"]`).click();
    });
    await chooseMode('surprisal-local');
    assert.equal((await step('selected-mode-config',()=>support.readStoredConfig(control))).informationHighlight.mode,'surprisal-local');
    await step('settings-model-card-visible',()=>control.locator('#information-highlight-settings [data-testid="information-highlight-model-card"]').waitFor());
    const readModelStatus=(selectedId=modelId)=>step(`model-status-rpc:${selectedId}`,async()=>{
      const envelope=await control.evaluate(modelId=>chrome.runtime.sendMessage({type:'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS',modelId}),selectedId);
      assert(envelope?.success&&envelope.status,JSON.stringify(envelope));assert.equal(envelope.status.modelId,selectedId);assert.equal(envelope.status.modelName,models[selectedId].name);assert.equal(envelope.status.totalBytes,models[selectedId].bytes);return envelope;
    });
    const chooseModel=selectedId=>step(`native-settings-model:${selectedId}`,async()=>{
      const descriptor=models[selectedId],selector=control.locator('#information-highlight-settings [data-information-highlight-model-select]');
      await selector.waitFor();await selector.scrollIntoViewIfNeeded();await selector.click();
      await control.getByRole('option',{name:descriptor.name,exact:true}).click();
      await control.waitForFunction(name=>document.querySelector('[data-testid="information-highlight-model-card"] .highlight-model-heading strong')?.textContent.trim()===name,descriptor.name);
      for(const deadline=Date.now()+8000;;){const stored=(await support.readStoredConfig(control)).informationHighlight;if(stored.model===selectedId)break;assert(Date.now()<deadline,`Model selection was not persisted: ${stored.model}`);await delay(100);}
      return {modelId:selectedId,name:descriptor.name,selection:'native-model-option-click'};
    });
    const inspectModelCard=(descriptor,expectedAction)=>step(`model-card-single-action:${descriptor.id}:${expectedAction}`,async()=>{
      await control.waitForFunction(({name,label})=>{
        const card=document.querySelector('[data-testid="information-highlight-model-card"]'),actions=card?.querySelectorAll('.highlight-model-actions button');
        return card?.querySelector('.highlight-model-heading strong')?.textContent.trim()===name&&actions?.length===1&&actions[0].textContent.trim()===label;
      },{name:descriptor.name,label:expectedAction},{timeout:30000});
      const snapshot=await control.locator('[data-testid="information-highlight-model-card"]').evaluate(element=>({
        name:element.querySelector('.highlight-model-heading strong').textContent.trim(),description:element.querySelector('.highlight-model-heading small')?.textContent.trim(),text:element.textContent.trim(),
        actions:[...element.querySelectorAll('.highlight-model-actions button')].map(button=>({text:button.textContent.trim(),disabled:button.disabled,download:button.hasAttribute('data-information-highlight-download'),remove:button.hasAttribute('data-information-highlight-remove'),pause:button.hasAttribute('data-information-highlight-pause')})),
      }));
      assert.equal(snapshot.actions.length,1);assert.equal(snapshot.actions[0].text,expectedAction);
      assert.equal(snapshot.description,'下载 Qwen，在本机离线计算词语意外度，需要支持 shader-f16 的WebGPU环境。');
      const groupText=await control.locator('#information-highlight-settings').innerText();
      assert(!/模型文件已就绪|下载只获取模型文件|分析正文不离开此设备|已下载\s*[·•]\s*可离线使用|由\s*FluentRead\s*下载|FluentRead\s*下载\s*Qwen/u.test(groupText),'Removed model helpers and duplicate descriptions must be absent');
      return snapshot;
    },35000);
    for(const selectedId of [otherModel.id,modelId]){
      const selection=await chooseModel(selectedId),status=(await readModelStatus(selectedId)).status;
      assert.equal(status.downloaded,false);assert.equal(status.downloadedBytes,0,'Selecting a model must not download or reuse another model artifacts');
      const descriptor=models[selectedId],card=await inspectModelCard(descriptor,`下载模型（${(descriptor.bytes/1_000_000).toFixed(0)} MB）`);
      report.cases.push({id:`native-model-choice-no-automatic-download:${selectedId}`,selection,status,card});
    }
    await step('settings-reload-after-model-choice',()=>control.reload({timeout:30000}),35000);await openHighlightSettings(control);
    assert((await control.locator('[data-information-highlight-model-select]').innerText()).includes(model.name));
    assert.equal((await support.readStoredConfig(control)).informationHighlight.model,modelId);
    report.persistenceCases.push({id:'native-model-selection-reload-persists',modelId,name:model.name});
    const absent=await readModelStatus();assert.equal(absent.status.downloaded,false);assert.equal(absent.status.downloadedBytes,0,'Choosing local mode must not download artifacts');
    report.cases.push({id:'settings-real-model-mode-selector-no-automatic-download',modelId,status:absent.status,card:await inspectModelCard(model,downloadLabel)});
    await step('settings-model-card-scroll',()=>control.locator('[data-testid="information-highlight-model-card"]').scrollIntoViewIfNeeded());await shot(control,'settings-model-mode');
    await shot(control.locator('[data-testid="information-highlight-model-card"]'),'model-card-download');
    if(args['download-model']){
      assert(absent.status.supported,`Real download validation requires WebGPU shader-f16: ${absent.status.reason||'unsupported'}`);
      networkStage='production-settings-download';report.model={artifactAcquisition:'production-settings-download',statusHistory:[],actions:[],pauseAfterBytes:8*1024*1024,networkObservationScope:report.networkObservation.scope,fixtureArtifactImport:false};save();
      const recordStatus=(envelope,name)=>{
        const status=envelope.status,previous=report.model.statusHistory.at(-1);
        if(!previous||previous.stage!==name||previous.status.phase!==status.phase||previous.status.downloadedBytes!==status.downloadedBytes||previous.status.downloaded!==status.downloaded)report.model.statusHistory.push({at:Date.now(),stage:name,status});
        report.model.status=envelope;save();return status;
      };
      const waitModel=(predicate,name,timeout=downloadTimeout)=>step(`download-wait:${name}`,async()=>{
        const deadline=Date.now()+timeout;while(Date.now()<deadline){
          const status=recordStatus(await readModelStatus(),name);assert(status.phase!=='error',`Product download failed: ${status.errorCode||status.reason||JSON.stringify(status)}`);
          if(predicate(status))return status;await delay(500);
        }throw new Error(`Timed out waiting for genuine model download: ${name}`);
      },timeout+1000);
      const before=recordStatus(await readModelStatus(),'before-prepare');assert.equal(before.downloadedBytes,0);assert.equal(before.downloaded,false);
      report.model.actions.push({at:Date.now(),action:'prepare',via:'native-settings-button',metrics:await settingButton('[data-information-highlight-download]','model-prepare')});
      const partial=await waitModel(status=>status.downloadedBytes>=report.model.pauseAfterBytes&&!status.downloaded,'partial-download',Math.min(downloadTimeout,180000));
      assert(partial.downloadedBytes<partial.totalBytes);
      await step('settings-progress-positive',()=>control.waitForFunction(()=>document.querySelector('[data-testid="information-highlight-model-progress"] progress')?.value>0));
      report.model.visibleDownloadProgress=await step('settings-progress-snapshot',()=>control.locator('[data-testid="information-highlight-model-progress"]').evaluate(element=>({loaded:element.querySelector('progress').value,total:element.querySelector('progress').max,text:element.textContent.trim()})));
      assert.equal(report.model.visibleDownloadProgress.total,partial.totalBytes);await shot(control,'settings-model-download-progress');
      report.model.actions.push({at:Date.now(),action:'pause',via:'native-settings-button',metrics:await settingButton('[data-information-highlight-pause]','model-pause'),downloadedBytesBefore:partial.downloadedBytes});
      const paused=await waitModel(status=>status.phase==='paused'&&status.downloadedBytes>0&&!status.downloaded,'paused',30000);await delay(1500);
      const settled=recordStatus(await readModelStatus(),'paused-settled');assert.equal(settled.phase,'paused');assert(settled.downloadedBytes>=paused.downloadedBytes);
      report.cases.push({id:'product-model-settings-download-and-pause',before,partial,paused:settled});await shot(control,'settings-model-download-paused');
      await step('settings-close-after-pause',()=>control.close());
      // 重用先前检查过的普通 Popup 页签作为真正重开的设置页，不为续传新增窗口或 Target。
      control=popup;await step('reopened-settings-size',()=>control.setViewportSize({width:1440,height:1000}));await navigate(control,optionsUrl,'reopen-settings-after-pause');await activate(control,'resume-settings');await openHighlightSettings(control);
      const reopened=recordStatus(await readModelStatus(),'reopened-paused');assert.equal(reopened.phase,'paused');assert.equal(reopened.downloadedBytes,settled.downloadedBytes);
      await step('settings-resume-label',()=>control.getByRole('button',{name:'继续下载',exact:true}).waitFor());
      report.model.actions.push({at:Date.now(),action:'resume',via:'native-reopened-settings-button',metrics:await settingButton('[data-information-highlight-download]','model-resume'),retainedBytes:reopened.downloadedBytes});
      const ready=await waitModel(status=>status.downloaded&&status.phase==='ready','resumed-download');assert.equal(ready.downloadedBytes,ready.totalBytes);assert.equal(ready.totalBytes,before.downloadSizeBytes);
      const receipts=await step('production-artifact-receipts',()=>control.evaluate(async cacheName=>{
        const cache=await caches.open(cacheName),files=[];
        for(const key of await cache.keys()){const url=new URL(key.url);if(!url.searchParams.has('fluent-read-verified'))continue;const response=await cache.match(key);files.push({url:`${url.origin}${url.pathname}`,receipt:await response.json()});}return files;
      },model.cacheName));
      assert(receipts.length>0);assert.equal(receipts.reduce((total,file)=>total+file.receipt.size,0),ready.downloadedBytes);
      assert(receipts.every(file=>file.url.startsWith(modelUrlPrefix)&&/^[a-f0-9]{64}$/u.test(file.receipt.sha256)));
      report.model.artifacts={evidence:'production-cache-verification-receipts',files:receipts,totalBytes:ready.downloadedBytes};report.cases.push({id:'product-model-settings-reopen-resume-to-ready',reopened,ready,artifactCount:receipts.length,reusedTarget:true});
      report.unverified=report.unverified.filter(item=>item!=='product model download/pause/resume');
      await step('download-action-hidden-after-ready',()=>control.locator('[data-information-highlight-download]').waitFor({state:'hidden',timeout:30000}));
      report.cases.push({id:'native-download-action-becomes-single-delete-action',modelId,card:await inspectModelCard(model,'删除模型')});
      await step('ready-card-scroll',()=>control.locator('[data-testid="information-highlight-model-card"]').scrollIntoViewIfNeeded());await shot(control,'settings-model-downloaded');save();
    }
    if(modelManifest.length){
      networkStage='verified-local-artifact-import';
      await step('local-model-sha-verification',async()=>{
        for(const file of modelManifest){assert.equal(fs.statSync(path.join(args['model-dir'],file.path)).size,file.size);const hash=createHash('sha256');for await(const chunk of fs.createReadStream(path.join(args['model-dir'],file.path)))hash.update(chunk);assert.equal(hash.digest('hex'),file.sha256);}
      },120000);
      const imported=await step('verified-local-artifact-import',()=>control.evaluate(async({manifest,localOrigin,cacheName})=>{
        const cache=await caches.open(cacheName);let total=0;
        for(const file of manifest){
          for(let offset=0,index=0;offset<file.size;offset+=4*1024*1024,index++){
            const end=Math.min(file.size-1,offset+4*1024*1024-1),response=await fetch(`${localOrigin}/models/${file.path}`,{headers:{Range:`bytes=${offset}-${end}`}});
            if(response.status!==206)throw Error('Test artifact range fetch failed');const bytes=await response.arrayBuffer();
            await cache.put(`${file.url}?fluent-read-part=${index}`,new Response(bytes,{headers:{'Content-Length':String(bytes.byteLength)}}));total+=bytes.byteLength;
          }await cache.put(`${file.url}?fluent-read-verified=${file.sha256}`,new Response(JSON.stringify({size:file.size,sha256:file.sha256})));
        }return total;
      },{manifest:modelManifest,localOrigin:`http://127.0.0.1:${server.address().port}`,cacheName:model.cacheName}),180000);
      report.model={modelId,cacheName:model.cacheName,artifactImport:'sha-verified-local-files-to-temporary-extension-cache',importedBytes:imported,files:modelManifest};save();
    }
    if(modelManifest.length||args['download-model']){
      let status;for(let attempt=0;attempt<5;attempt++){status=await readModelStatus();if(status.status.downloaded)break;await delay(500);}
      report.model.status=status;assert(status.success&&status.status.downloaded);
      report.cases.push({id:'prepared-artifacts-change-single-download-to-delete',modelId,artifactAcquisition:report.model.artifactImport||report.model.artifactAcquisition,card:await inspectModelCard(model,'删除模型')});
      await shot(control.locator('[data-testid="information-highlight-model-card"]'),'model-card-downloaded');
      if(modelManifest.length){await step('prepared-model-card-scroll',()=>control.locator('[data-testid="information-highlight-model-card"]').scrollIntoViewIfNeeded());await shot(control,'settings-model-downloaded');}
      assert.equal((await readModelStatus(otherModel.id)).status.downloaded,false,'The other model must not report this model files as ready');
      if(status.status.supported){
        networkStage='local-model-inference';const forbidden=[];
        await step('local-inference-page-network-guard',()=>context.route(/^https:\/\/(?:huggingface\.co|hf-mirror\.com)\//u,route=>{forbidden.push(route.request().url());return route.abort('blockedbyclient');}));
        // SCORE 的 trusted sender 必须是精确 document.html；正常导航同一已有页签，不扩大生产消息来源政策。
        await navigate(control,`${origin}/document.html`,'reuse-settings-tab-for-trusted-model-score');await activate(control,'document-model-score');
        report.model.scoreSender='existing-tab-navigated-to-document-page';save();
        for(const [index,text]of ['浏览器本地模型计算信息意外度，不上传正文。','A local model scores cafe\u0301 and 👩🏽‍💻 in the browser.'].entries()){
          const started=performance.now();
          const response=await step(index?'score:warm-unicode':'score:cold-chinese',()=>control.evaluate(({text,id,modelId})=>chrome.runtime.sendMessage({type:'SCORE_INFORMATION_HIGHLIGHT',text,requestId:id,modelId}),{text,id:randomUUID(),modelId}),150000);
          assert(response.success,JSON.stringify(response));assert.equal(response.result.engine,`${model.name} · local WebGPU · q4f16`);assert(response.result.spans.length>0);assert(response.result.spans.every(span=>Number.isFinite(span.score)&&span.score>=0&&span.start>=0&&span.end<=text.length&&span.end>span.start));
          report.cases.push({id:index?'real-model-warm-unicode':'real-model-cold-chinese',milliseconds:performance.now()-started,text,result:response.result,surface:'existing-tab-navigated-to-document-page'});save();
        }
        const repeated=report.cases.find(item=>item.id==='real-model-cold-chinese'),repeatStarted=performance.now();
        const repeat=await step('score:warm-repeat',()=>control.evaluate(({text,id,modelId})=>chrome.runtime.sendMessage({type:'SCORE_INFORMATION_HIGHLIGHT',text,requestId:id,modelId}),{text:repeated.text,id:randomUUID(),modelId}),150000);
        assert(repeat.success);assert.deepEqual(repeat.result,repeated.result);report.cases.push({id:'real-model-warm-repeat-identical-result',milliseconds:performance.now()-repeatStarted,text:repeated.text});
        const cancellation=await step('score:cancel',()=>control.evaluate(async({id,modelId})=>{
          const score=chrome.runtime.sendMessage({type:'SCORE_INFORMATION_HIGHLIGHT',text:'浏览器本地语言模型支持离线分析，但不能改变原文。'.repeat(35),requestId:id,modelId});await new Promise(resolve=>setTimeout(resolve,30));
          return{cancel:await chrome.runtime.sendMessage({type:'CANCEL_INFORMATION_HIGHLIGHT',requestId:id,modelId}),score:await score};
        },{id:randomUUID(),modelId}),150000);
        assert(cancellation.cancel.success);assert(!cancellation.score.success);report.cases.push({id:'real-model-cancel',response:cancellation});assert.equal(forbidden.length,0);
        report.model.observedInterceptedModelRequests=forbidden;report.model.inferenceRequestInterceptionScope='page-routes-only; extension workers rely on verified local-only model configuration';report.model.networkObservationScope=report.networkObservation.scope;
        report.unverified=report.unverified.filter(item=>item!=='local model inference');save();
      }else report.model.gpuInferenceUnavailable=status.status.reason;
    }
    networkStage='pdf-reading-tests';await patchConfig({informationHighlight:{enabled:false,hotkey:'Alt+H',hotkeyEnabled:true,mode:'keywords',model:modelId,density:'medium',color:'amber',style:'background',intensity:'standard'}});
    // 同一现有 Options 页改为阅读器；仍通过正常导航、上传与阅读按钮完成产品流程。
    const documentReader=control;if(documentReader.url()!==`${origin}/document.html`)await navigate(documentReader,`${origin}/document.html`,'reuse-settings-tab-for-pdf');await activate(documentReader,'pdf-reader');
    await step('pdf-drop-zone',()=>documentReader.locator('.file-drop-zone').waitFor());
    const {PDFDocument,StandardFonts}=require('pdf-lib'),pdf=await PDFDocument.create(),pdfPage=pdf.addPage([595,842]),font=await pdf.embedFont(StandardFonts.Helvetica);
    ['Local browser models analyse reading text without uploading.','Information highlighting preserves original document layout.','Important terms and numerical conditions need careful reading.'].forEach((line,index)=>pdfPage.drawText(line,{font,x:44,y:748-index*32,size:12}));
    const pdfBytes=Buffer.from(await pdf.save());
    await step('pdf-upload',()=>documentReader.locator('input[type=file]').setInputFiles({name:'information-highlight-fixture.pdf',mimeType:'application/pdf',buffer:pdfBytes}));
    await step('pdf-workspace',()=>documentReader.locator('.workspace-heading h1').filter({hasText:'information-highlight-fixture.pdf'}).waitFor({timeout:60000}),65000);
    await step('pdf-open-reading',()=>documentReader.getByRole('button',{name:'阅读',exact:true}).click());
    const textLayer=documentReader.locator('[data-fluentread-pdf-text]').first();await step('pdf-text-layer',()=>textLayer.locator('span').first().waitFor({timeout:30000}));
    const pdfToggle=documentReader.locator('.pdf-information-highlight');assert(await step('pdf-toggle-enabled',()=>pdfToggle.isEnabled()));assert.equal(await step('pdf-toggle-initial',()=>pdfToggle.getAttribute('aria-pressed')),'false');
    const pdfBefore=await step('pdf-source-before',()=>textLayer.evaluate(element=>{window.__pdfInfoSource=[...element.querySelectorAll('span')].map(span=>span.firstChild);return{html:element.innerHTML,text:element.textContent,rect:element.getBoundingClientRect().toJSON()};}));
    await step('pdf-keywords-enable',()=>pdfToggle.click());await step('pdf-keywords-paint',()=>documentReader.waitForFunction(()=>CSS.highlights?.get('fluentread-information-highlight')?.size>0,null,{timeout:30000}));
    const pdfRanges=await step('pdf-keywords-ranges',()=>textRanges(documentReader));assert(pdfRanges.length>0);
    report.pdfToggleStyle=await step('pdf-toggle-style',()=>pdfToggle.evaluate(element=>{const computed=getComputedStyle(element);return{color:computed.color,border:computed.borderColor,background:computed.backgroundColor,brand:computed.getPropertyValue('--brand').trim()};}));assert.notEqual(report.pdfToggleStyle.color,'rgb(39, 49, 43)');
    const pdfAfter=await step('pdf-source-after',()=>textLayer.evaluate(element=>({html:element.innerHTML,text:element.textContent,rect:element.getBoundingClientRect().toJSON(),sameNodes:window.__pdfInfoSource.every(node=>node.isConnected&&element.contains(node))})));
    assert.equal(pdfBefore.html,pdfAfter.html);assert.equal(pdfBefore.text,pdfAfter.text);assert.deepEqual(pdfBefore.rect,pdfAfter.rect);assert(pdfAfter.sameNodes);
    report.cases.push({id:'pdf-keywords-native-text-layer-preservation',ranges:pdfRanges,protection:pdfAfter});await shot(documentReader,'pdf-keywords');
    await step('pdf-keywords-disable',()=>pdfToggle.click());assert.equal((await step('pdf-disabled-ranges',()=>textRanges(documentReader))).length,0);report.cases.push({id:'pdf-disable-clears'});
    if(!report.unverified.includes('local model inference')){
      await patchConfig({informationHighlight:{enabled:false,hotkey:'Alt+H',hotkeyEnabled:true,mode:'surprisal-local',model:modelId,density:'medium',color:'amber',style:'background',intensity:'standard'}});
      await step('pdf-local-toggle-ready',()=>documentReader.waitForFunction(()=>document.querySelector('.pdf-information-highlight')?.getAttribute('aria-pressed')==='false'));
      await step('pdf-local-enable',()=>pdfToggle.click());await step('pdf-local-paint',()=>documentReader.waitForFunction(()=>CSS.highlights?.get('fluentread-information-highlight')?.size>0,null,{timeout:120000}),125000);
      report.cases.push({id:'pdf-real-model-text-layer-highlights',ranges:await step('pdf-local-ranges',()=>textRanges(documentReader))});await shot(documentReader,'pdf-local-model');
      await step('pdf-local-disable',()=>pdfToggle.click());assert.equal((await step('pdf-local-disabled-ranges',()=>textRanges(documentReader))).length,0);
    }
    // 推理与 PDF 都完成后才删除；取消与确认通过真正的 MessageBox 按钮，不伪造响应或模型就绪状态。
    if(modelManifest.length||args['download-model']){
      networkStage='model-choice-and-delete-tests';
      await navigate(control,optionsUrl,'reuse-document-tab-for-model-delete');await activate(control,'model-delete-settings');await openHighlightSettings(control);
      await chooseMode('surprisal-local');
      const preparedBeforeSwitch=(await readModelStatus()).status;assert.equal(preparedBeforeSwitch.downloaded,true);
      await chooseModel(otherModel.id);const otherStatus=(await readModelStatus(otherModel.id)).status;
      assert.equal(otherStatus.downloaded,false);assert.equal(otherStatus.downloadedBytes,0);
      const otherCard=await inspectModelCard(otherModel,`下载模型（${(otherModel.bytes/1_000_000).toFixed(0)} MB）`);
      await chooseModel(modelId);const preparedAfterSwitch=(await readModelStatus()).status;
      assert.equal(preparedAfterSwitch.downloaded,true);assert.equal(preparedAfterSwitch.downloadedBytes,preparedBeforeSwitch.downloadedBytes);
      const readyCard=await inspectModelCard(model,'删除模型');
      report.cases.push({id:'native-model-switch-keeps-downloaded-artifacts-isolated',modelId,otherModelId:otherModel.id,preparedBeforeSwitch,otherStatus,otherCard,preparedAfterSwitch,readyCard});
      const cacheKeys=cacheName=>control.evaluate(async name=>(await (await caches.open(name)).keys()).map(request=>request.url).sort(),cacheName);
      // 此标记只证明另一模型的命名缓存没有被清空；它不是第二份模型，也不用于推断其可用状态。
      const retentionMarker=`${fixtureUrl}/__information-highlight-cache-retention-${randomUUID()}`,markerText='temporary-runner-cache-retention-marker';
      await step('other-model-cache-retention-marker',()=>control.evaluate(async({cacheName,url,text})=>(await caches.open(cacheName)).put(url,new Response(text)),{cacheName:otherModel.cacheName,url:retentionMarker,text:markerText}));
      const beforeDelete={selected:await cacheKeys(model.cacheName),other:await cacheKeys(otherModel.cacheName)};
      assert(beforeDelete.selected.some(url=>url.startsWith(modelUrlPrefix)&&url.includes('fluent-read-verified=')));
      const dialog=control.getByRole('dialog',{name:'删除模型',exact:true});
      await settingButton('[data-information-highlight-remove]','model-delete-open-cancel');
      await step('model-delete-confirmation-visible',()=>dialog.waitFor());
      const confirmationText=(await dialog.innerText()).trim();assert(confirmationText.includes(`删除 ${model.name} 的本地模型文件？再次使用时需要重新下载。`));
      const waitingForConfirmation=(await readModelStatus()).status;assert.equal(waitingForConfirmation.downloaded,true,'Opening the confirmation dialog must retain the model');
      const confirmationAppearance=await step('model-delete-confirmation-animation-settled',async()=>{
        await control.waitForFunction(async()=>{
          const box=document.querySelector('.el-message-box'),dialog=box?.closest('[role="dialog"]'),overlay=dialog?.closest('.el-overlay');
          if(!box||!dialog||!overlay||overlay.getAnimations({subtree:true}).some(animation=>animation.pending||animation.playState==='running'))return false;
          for(const element of [overlay,dialog,box]){
            const style=getComputedStyle(element);if(Number(style.opacity)<0.999||style.visibility!=='visible'||style.display==='none')return false;
            if(style.transform!=='none'&&!new DOMMatrix(style.transform).isIdentity)return false;
          }
          const before=box.getBoundingClientRect();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const after=box.getBoundingClientRect();
          return before.width>0&&before.height>0&&['x','y','width','height'].every(field=>Math.abs(before[field]-after[field])<0.1);
        },null,{timeout:10000});
        return dialog.locator('.el-message-box').evaluate(box=>{
          const overlay=box.closest('.el-overlay'),dialog=box.closest('[role="dialog"]'),style=getComputedStyle(box);
          return {rect:box.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},backgroundColor:style.backgroundColor,
            layers:[overlay,dialog,box].map(element=>({opacity:getComputedStyle(element).opacity,transform:getComputedStyle(element).transform})),
            runningAnimations:overlay.getAnimations({subtree:true}).filter(animation=>animation.pending||animation.playState==='running').length};
        });
      },15000);
      assert(confirmationAppearance.layers.every(layer=>Number(layer.opacity)>=0.999));assert.equal(confirmationAppearance.runningAnimations,0);
      assert(!['transparent','rgba(0, 0, 0, 0)'].includes(confirmationAppearance.backgroundColor),'Confirmation box must have an opaque readable surface');
      assert(confirmationAppearance.rect.x>=0&&confirmationAppearance.rect.y>=0&&confirmationAppearance.rect.right<=confirmationAppearance.viewport.width+1&&confirmationAppearance.rect.bottom<=confirmationAppearance.viewport.height+1);
      report.cases.push({id:'native-model-delete-confirmation-settled-and-readable',modelId,appearance:confirmationAppearance});
      await shot(control,'settings-model-delete-confirmation');
      await step('model-delete-cancel',()=>dialog.getByRole('button',{name:'取消',exact:true}).click());
      await step('model-delete-cancel-closes-dialog',()=>dialog.waitFor({state:'hidden'}));
      const canceledStatus=(await readModelStatus()).status;assert.equal(canceledStatus.downloaded,true);assert.equal(canceledStatus.downloadedBytes,preparedAfterSwitch.downloadedBytes);
      assert.deepEqual(await cacheKeys(model.cacheName),beforeDelete.selected);assert.deepEqual(await cacheKeys(otherModel.cacheName),beforeDelete.other);
      report.cases.push({id:'native-model-delete-cancel-retains-artifacts',modelId,confirmationText,status:canceledStatus,card:await inspectModelCard(model,'删除模型')});
      await settingButton('[data-information-highlight-remove]','model-delete-open-confirm');await step('model-delete-second-confirmation',()=>dialog.waitFor());
      await step('model-delete-confirm',()=>dialog.getByRole('button',{name:'删除模型',exact:true}).click());
      await step('model-delete-confirm-closes-dialog',()=>dialog.waitFor({state:'hidden'}));
      const deleted=await step('model-delete-removes-selected-artifacts',async()=>{
        for(const deadline=Date.now()+30000;;){const status=(await readModelStatus()).status;if(!status.downloaded&&status.downloadedBytes===0)return status;assert(Date.now()<deadline,'Confirmed model deletion did not remove selected artifacts');await delay(200);}
      },35000);
      const deletedCard=await inspectModelCard(model,downloadLabel),afterDelete={selected:await cacheKeys(model.cacheName),other:await cacheKeys(otherModel.cacheName)};
      assert(!afterDelete.selected.some(url=>url.startsWith(modelUrlPrefix)));assert.deepEqual(afterDelete.other,beforeDelete.other);
      const retainedText=await control.evaluate(async({cacheName,url})=>(await (await caches.open(cacheName)).match(url))?.text(),{cacheName:otherModel.cacheName,url:retentionMarker});assert.equal(retainedText,markerText);
      assert.equal((await readModelStatus(otherModel.id)).status.downloaded,false);
      report.cases.push({id:'native-model-delete-confirm-restores-single-download-action',modelId,status:deleted,card:deletedCard,selectedCacheArtifactKeysBefore:beforeDelete.selected.length,selectedCacheArtifactKeysAfter:afterDelete.selected.length,
        otherCacheRetention:{cacheName:otherModel.cacheName,markerRetained:true,keysBefore:beforeDelete.other.length,keysAfter:afterDelete.other.length,evidence:'synthetic-cache-retention-marker; second complete model was not imported'}});
      await shot(control,'settings-model-deleted');
      await shot(control.locator('[data-testid="information-highlight-model-card"]'),'model-card-download');
      await step('cleanup-other-cache-retention-marker',()=>control.evaluate(async({cacheName,url})=>(await caches.open(cacheName)).delete(url),{cacheName:otherModel.cacheName,url:retentionMarker}));
    }
    await step('final-focus-check',()=>checkFocus());assert(!fatalError);assert.equal(report.consoleErrors.length,0,JSON.stringify(report.consoleErrors));
    assert(!report.consoleWarnings.some(item=>item.message.includes('Failed to resolve component')),JSON.stringify(report.consoleWarnings));report.ok=true;checkpoint('validation-complete','after');
  }catch(error){
    primaryError||=fatalError||error;report.ok=false;report.error=primaryError.stack||String(primaryError);if(focusMonitor)report.focusEvents=[...focusMonitor.events];save();
    if(session&&!fatalError)for(const [index,page]of session.context.pages().entries())try{
      await step(`failure-diagnostics:${index}`,async()=>{report.diagnostics??=[];report.diagnostics.push({url:page.url(),text:(await page.locator('body').innerText({timeout:3000})).slice(0,15000)});},5000,{ignoreFatal:true});
      await shot(page,`failure-surface-${index}`);
    }catch{}
  }finally{
    cleanupStarted=true;if(focusTimer)clearInterval(focusTimer);checkpoint('cleanup','before');
    if(session)try{await step('cleanup-owned-browser',()=>session.close(),15000,{ignoreFatal:true});report.browserCloseReceipt='shared-guard-fulfilled';}
    catch(error){report.cleanupError=String(error);report.ok=false;primaryError||=error;save();}
    else if(report.stages.some(entry=>entry.name==='browser-launch'))report.retainedProfileReason='Launch did not return an owned session';
    if(focusMonitor){report.focusEvents=[...focusMonitor.events];try{await step('cleanup-focus-observer',()=>focusMonitor.stop(),10000,{ignoreFatal:true});}
      catch(error){report.focusObserverCleanupError=String(error);report.ok=false;primaryError||=error;save();}
      if(focusMonitor.error){report.focusObserverError=String(focusMonitor.error);report.ok=false;primaryError||=focusMonitor.error;save();}}
    if(server.listening)try{await step('cleanup-fixture-server',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),5000,{ignoreFatal:true});}
    catch(error){report.serverCleanupError=String(error);report.ok=false;primaryError||=error;server.closeAllConnections?.();save();}
    if(report.browserCloseReceipt==='shared-guard-fulfilled')try{
      await step('cleanup-owned-profile',()=>fs.rmSync(profileDir,{recursive:true,force:true}),15000,{ignoreFatal:true});report.profileRemoved=true;
    }catch(error){report.profileCleanupError=String(error);report.ok=false;primaryError||=error;save();}
    checkpoint('cleanup','after');save();
  }
  console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,report:path.join(artifacts,'report.json'),error:report.error}));
  if(primaryError)process.exitCode=1;
})();
