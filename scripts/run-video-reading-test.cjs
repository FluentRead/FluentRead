#!/usr/bin/env node
/** 视频读音专项：生产扩展、隔离后台 Edge、真实本地引擎；网页、媒体、翻译及固定下载字节为本地回放。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
function arg(name, fallback) {const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];}
const extensionDir=path.resolve(arg('extension-dir','.output/chrome-mv3'));
const artifactsDir=path.resolve(arg('artifacts-dir',path.join(os.tmpdir(),'fluentread-video-reading')));
const runtimeRoot=arg('playwright-root',process.env.PLAYWRIGHT_ROOT);
const repositoryHelper=path.join(__dirname,'testing/focus-safe-browser.cjs');
const helperPath=arg('focus-safe-helper',repositoryHelper);
const readingDataDir=arg('reading-data-dir');
// 与生产清单相同的固定版本字节；仅允许纯数据 URL，任何远程脚本或 WASM 都会进入 unexpectedNetwork。
const japaneseSources=['https://cdn.jsdelivr.net/npm/@faanau/kuromoji@0.2.1/dict/','https://unpkg.com/@faanau/kuromoji@0.2.1/dict/'];
const hindiRevision='3e519d5cfb689c2444545396e4cfab24d3a2d84a';
const hindiSources=[`https://raw.githubusercontent.com/budhash/gomanize/${hindiRevision}/lang/hindi/`,`https://cdn.jsdelivr.net/gh/budhash/gomanize@${hindiRevision}/lang/hindi/`];
const dataManifest=[
  ...[
    ['base.dat.gz',3956825,'0803327762e1c93ca731e4319ab8343340f2806bb84941207782cde9d2d5a8eb'],
    ['cc.dat.gz',1692067,'02b7631be0d4de3a1a75cd9f9cc51536e4f94c9e6b389b813e06ba0f6e7de765'],
    ['check.dat.gz',3111633,'193ae0035fff6fe812b58d9ee730e7a7d7ee601d918481ce51075c58114f6cc9'],
    ['tid.dat.gz',1605820,'d43d831cb6fb0f0a411739cd287a6d5e998e121a8daca614df14a81a0dcac586'],
    ['tid_map.dat.gz',1485576,'33efd5ffd87a70f669add093fa39dee44341d58f940844ef107c8fd98bb795b2'],
    ['tid_pos.dat.gz',5916009,'60dbfc99a6ab993f30c5dab648bec6ad7f9aaefa5c14e1843837d95e509f8895'],
    ['unk.dat.gz',10512,'f7f991cdeb9bfd3e9c0e4577cc50ee0815a11c508cccd444a9d3ab3c81521100'],
    ['unk_char.dat.gz',306,'9a8e86fd9aff32d323fbb59f5a7006f05927a11f8173c90712cc56293aeb3225'],
    ['unk_compat.dat.gz',338,'50f60aa29bc2e86c2903ab8c825bb6fa604d2b294d96941c1d3924259791899d'],
    ['unk_invoke.dat.gz',1140,'6b210889548457c3006913afd12c8b525562255f2709e404604be9614a25e94c'],
    ['unk_map.dat.gz',1190,'6df12460e5477230bb6fd9641def918b699fc0a8868016b6c9f794488630509b'],
    ['unk_pos.dat.gz',10540,'5b183a29f281acc7e0542beca47b83f7985047c0a2d27e78a66f32276be5ad11'],
  ].map(([name,size,sha256])=>({language:'ja',name,size,sha256,urls:japaneseSources.map(source=>source+name)})),
  ...[
    ['lexicon.tsv',208827,'6fc9955ed159d1237ae28efec2ce762bca44dd50c964f307944fb8d8a27aa517'],
    ['roman_ngrams.tsv',228964,'29d9e05cde8aa5cb44ce79810479cf7df8b86baafcf27fa95a8f8d10fe052d16'],
    ['schwa_tree.json',34463,'d071eeb37f1abdb4461e5fb5379ca47d8e4120865a11c8cb6a3716396a1334ff'],
  ].map(([name,size,sha256])=>({language:'hi',name,size,sha256,urls:hindiSources.map(source=>source+name)})),
];
function loadReadingData() {
  if(!readingDataDir)throw Error('--reading-data-dir required; expected ja/ and hi/ with the fixed production data files');
  const routes=new Map(),files=[];
  for(const file of dataManifest) {
    const localPath=path.resolve(readingDataDir,file.language,file.name),body=fs.readFileSync(localPath);
    assert.equal(body.length,file.size,`Reading data size differs: ${localPath}`);
    assert.equal(createHash('sha256').update(body).digest('hex'),file.sha256,`Reading data SHA-256 differs: ${localPath}`);
    for(const url of file.urls)routes.set(url,{...file,body});
    files.push({language:file.language,name:file.name,size:file.size,sha256:file.sha256,localPath});
  }
  return {routes,files};
}

/** 只替换测试 Worker 的数据 fetch；Response、CacheStorage、摘要、解压和生产引擎都保持原生实现。 */
function installFixtureWorkerFetch(bindingName,replyName) {
  const nativeFetch=globalThis.fetch.bind(globalThis),requests=new Map();let sequence=0;
  globalThis[replyName]=reply=>{
    const request=requests.get(reply.id);if(!request)return false;
    if(reply.error){requests.delete(reply.id);request.cleanup();request.reject(new Error(reply.error));return true;}
    if(reply.chunk){
      const binary=atob(reply.chunk),bytes=new Uint8Array(binary.length);
      for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
      request.chunks.push(bytes);
    }
    if(reply.done){
      requests.delete(reply.id);request.cleanup();
      request.resolve(new Response(new Blob(request.chunks),{status:200,headers:reply.headers}));
    }
    return true;
  };
  globalThis.fetch=(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,globalThis.location.href);
    if(url.protocol!=='http:'&&url.protocol!=='https:')return nativeFetch(input,init);
    const signal=init.signal||(typeof Request!=='undefined'&&input instanceof Request?input.signal:undefined);
    if(signal?.aborted)return Promise.reject(signal.reason||new DOMException('Aborted','AbortError'));
    return new Promise((resolve,reject)=>{
      const id=++sequence,abort=()=>{requests.delete(id);signal.removeEventListener('abort',abort);reject(signal.reason||new DOMException('Aborted','AbortError'));};
      requests.set(id,{resolve,reject,chunks:[],cleanup:()=>signal?.removeEventListener('abort',abort)});
      signal?.addEventListener('abort',abort,{once:true});
      try {globalThis[bindingName](JSON.stringify({id,url:url.href,method:init.method||(typeof Request!=='undefined'&&input instanceof Request?input.method:'GET')}));}
      catch(error){requests.delete(id);signal?.removeEventListener('abort',abort);reject(error);}
    });
  };
  return true;
}

/** Offscreen 不属于 Playwright page 清单，其专属 Worker 必须从父 Target 递归附加后拦截。 */
async function interceptOffscreenWorkers(context,extensionId,readingData,report) {
  const cdp=await context.browser().newBrowserCDPSession();
  const pending=new Map(),workers=new Map();
  let parent,sequence=0,disposed=false,rejectFailure;
  const failed=new Promise((_,reject)=>{rejectFailure=reject;});failed.catch(()=>{});
  const bindingName='__fluentReadFixtureFetchRequest',replyName='__fluentReadFixtureFetchReply';
  const interception=report.readingData.interception={mode:'controlled-worker-runtime-fetch-replay-before-resume',attachedWorkers:[],ignoredTargets:[],nativeNetworkRequests:[],errors:[]};
  const failure=error=>{
    if(disposed)return;
    interception.errors.push(error.stack||String(error));rejectFailure(error);
  };
  const send=(sessions,method,params={},timeoutMs=10000)=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Worker CDP command timed out: ${method}`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});
    let message={id,method,params};
    // 内层命令通过各级 Target.sendMessageToTarget 信封送入相应 Worker，会话本身保持未扁平化。
    for(let index=sessions.length-1;index>0;index--)message={id:++sequence,method:'Target.sendMessageToTarget',params:{sessionId:sessions[index],message:JSON.stringify(message)}};
    void cdp.send('Target.sendMessageToTarget',{sessionId:sessions[0],message:JSON.stringify(message)}).catch(error=>{
      const request=pending.get(id);if(!request)return;pending.delete(id);clearTimeout(timer);reject(error);
    });
  });
  const evaluate=async(sessions,expression)=>{
    const result=await send(sessions,'Runtime.evaluate',{expression,returnByValue:true},30000);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Worker fixture evaluation failed');
    return result.result?.value;
  };
  const reply=(sessions,value)=>evaluate(sessions,`globalThis[${JSON.stringify(replyName)}](${JSON.stringify(value)})`);
  const fixtureRequest=async(sessions,event)=>{
    const request=JSON.parse(event.payload),url=new URL(request.url),data=readingData.routes.get(url.href);
    assert.ok(Number.isSafeInteger(request.id)&&request.id>0,'Worker fixture request id must be positive');
    if(data&&request.method==='GET') {
      const record={language:data.language,name:data.name,url:url.href,transport:'controlled-worker-runtime-fetch-replay',mode:report.readingData.networkBlocked?'blocked-cache-only':'local-replay'};
      report.readingData.requests.push(record);
      if(report.readingData.networkBlocked)await reply(sessions,{id:request.id,error:'Reading fixture data network blocked in cache-only phase'});
      else {
        // 最大词典文件为 5.9 MB；每次只传 512 KiB，避免多层 CDP 信封携带巨大的 base64 消息。
        for(let offset=0;offset<data.body.length;offset+=512*1024){
          if(!await reply(sessions,{id:request.id,chunk:data.body.subarray(offset,offset+512*1024).toString('base64')}))return;
        }
        await reply(sessions,{id:request.id,done:true,headers:{'Content-Type':'application/octet-stream','Content-Length':String(data.size),'Cache-Control':'no-store'}});
      }
      return;
    }
    report.unexpectedNetwork.push(url.href);
    await reply(sessions,{id:request.id,error:'Reading fixture blocked unexpected remote URL'});
  };
  const attached=async(sessions,event)=>{
    const workerSessions=[...sessions,event.sessionId],info=event.targetInfo;
    if(info.type!=='worker') {
      // Chromium 仍可能顺带关联后台 Service Worker；立即恢复，不把共享后台纳入专属读音拦截。
      const ignored={targetId:info.targetId,type:info.type,url:info.url,waitingForDebugger:event.waitingForDebugger===true,resumed:false};
      interception.ignoredTargets.push(ignored);
      await send(workerSessions,'Runtime.runIfWaitingForDebugger');
      ignored.resumed=true;
      return;
    }
    const worker={...info,ready:false,sessions:workerSessions};workers.set(info.targetId,worker);
    const attachedRecord={targetId:info.targetId,url:info.url,pausedBeforeExecution:event.waitingForDebugger===true};
    interception.attachedWorkers.push(attachedRecord);
    assert.equal(event.waitingForDebugger,true,'Offscreen Worker must pause before any application code executes');
    // Chromium 专属 Worker 不提供 Fetch domain；通过 Runtime 定点替换数据 fetch，并保留原生持久缓存。
    await send(workerSessions,'Runtime.enable');
    await send(workerSessions,'Runtime.addBinding',{name:bindingName});
    assert.equal(await evaluate(workerSessions,`(${installFixtureWorkerFetch.toString()})(${JSON.stringify(bindingName)},${JSON.stringify(replyName)})`),true);
    try {await send(workerSessions,'Network.enable');worker.nativeNetworkObservation=true;}
    catch(error){if(!String(error).includes('-32601'))throw error;worker.nativeNetworkObservation=false;}
    attachedRecord.nativeNetworkObservation=worker.nativeNetworkObservation;
    await send(workerSessions,'Runtime.runIfWaitingForDebugger');
    worker.ready=true;
  };
  const dispatch=(sessions,message)=>{
    if(message.id!==undefined) {
      const request=pending.get(message.id);
      if(request){pending.delete(message.id);clearTimeout(request.timer);if(message.error)request.reject(Error(JSON.stringify(message.error)));else request.resolve(message.result);}
      return;
    }
    if(message.method==='Target.receivedMessageFromTarget')dispatch([...sessions,message.params.sessionId],JSON.parse(message.params.message));
    else if(message.method==='Target.attachedToTarget')void attached(sessions,message.params).catch(failure);
    else if(message.method==='Target.detachedFromTarget'){
      for(const [id,worker]of workers)if(worker.sessions.at(-1)===message.params.sessionId)workers.delete(id);
    }
    else if(message.method==='Runtime.bindingCalled'&&message.params.name===bindingName)void fixtureRequest(sessions,message.params).catch(failure);
    else if(message.method==='Network.requestWillBeSent'&&/^https?:/u.test(message.params.request.url)){
      interception.nativeNetworkRequests.push(message.params.request.url);report.unexpectedNetwork.push(message.params.request.url);
      failure(Error(`Worker bypassed controlled data fetch: ${message.params.request.url}`));
    }
  };
  const receive=event=>{try{if(event.sessionId===parent)dispatch([parent],JSON.parse(event.message));}catch(error){failure(error);}};
  cdp.on('Target.receivedMessageFromTarget',receive);
  try {
    const infos=(await cdp.send('Target.getTargets')).targetInfos;
    const offscreen=infos.find(target=>target.type==='page'&&target.url===`chrome-extension://${extensionId}/offscreen.html`);
    assert.ok(offscreen,'The fixture must create its extension offscreen document before attaching Worker interception');
    ({sessionId:parent}=await cdp.send('Target.attachToTarget',{targetId:offscreen.targetId,flatten:false}));
    await send([parent],'Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:false,filter:[{type:'worker'},{exclude:true}]});
    return {
      race:operation=>Promise.race([operation,failed]),
      workers(){if(interception.errors.length)throw Error(interception.errors.join('\n'));return [...workers.values()].filter(worker=>worker.ready&&worker.url.includes('readingAnnotationWorker'));},
      async close(){
        disposed=true;cdp.off('Target.receivedMessageFromTarget',receive);
        for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Worker CDP interception disposed'));}pending.clear();
        await cdp.detach().catch(()=>{});
      },
    };
  }catch(error){
    disposed=true;cdp.off('Target.receivedMessageFromTarget',receive);
    for(const request of pending.values())clearTimeout(request.timer);pending.clear();
    await cdp.detach().catch(()=>{});throw error;
  }
}
let sequence=0;
async function readConfig(page) {
  return page.evaluate(async () => {
    const read=async key => {const r=await chrome.runtime.sendMessage({type:'configStorageRead',key});if(!r?.success)throw Error(r?.error||'config read');return typeof r.value==='string'?JSON.parse(r.value):r.value||{};};
    return {...await read('local:config'),...await read('local:credentials')};
  });
}
async function persist(page,patch) {
  const current=await readConfig(page);
  const response=await page.evaluate(({current,patch,sequence}) => chrome.runtime.sendMessage({type:'persistConfig',config:{...current,...patch},clientId:'video-reading-fixture',sequence,baseRevision:current.__fluentConfigRevision}),{current,patch,sequence:++sequence});
  assert.equal(response?.success,true,JSON.stringify(response));
}
async function main() {
  if (!runtimeRoot) throw Error('--playwright-root required');
  assert.equal(fs.realpathSync(helperPath),fs.realpathSync(repositoryHelper),'Use this checkout scripts/testing/focus-safe-browser.cjs for owned browser shutdown compatibility');
  const readingData=loadReadingData();
  fs.mkdirSync(artifactsDir,{recursive:true});
  const {chromium}=createRequire(path.join(path.resolve(runtimeRoot),'__reading_test.cjs'))('playwright');
  const {launchFocusSafePersistentContext,newPageWithoutForeground,activateExtensionTabWithoutForeground}=require(path.resolve(helperPath));
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-reading-edge-'));
  const report={extensionDir,scope:'production extension with deterministic YouTube/media/translation fixtures and controlled Worker fetch replay of verified local reading data; real local reading engines and browser CacheStorage; no live-CDN end-to-end, live-provider or real-site acceptance',readingData:{mode:'controlled-worker-fetch-replay-of-verified-local-data',directory:path.resolve(readingDataDir),files:readingData.files,requests:[],networkBlocked:false},cases:[],consoleErrors:[],unexpectedNetwork:[],passed:false};
  let session,context,page,readingNetwork;
  try {
    session=await launchFocusSafePersistentContext({chromium,profileDir,browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,displayTarget:'secondary',browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check'],viewport:{width:1280,height:900}});
    guardBrowserClose(session,profileDir); context=session.context;
    Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});
    await context.route('**/*',async route => {
      const url=new URL(route.request().url());
      if(url.protocol==='http:'||url.protocol==='https:') {report.unexpectedNetwork.push(url.href);await route.abort('blockedbyclient');} else await route.continue();
    });
    const background=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:30000});
    background.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
    await background.evaluate(()=>{
      const nativeFetch=fetch.bind(globalThis);
      globalThis.__readingNetworkAttempts=[];globalThis.__readingFixtureTranslations=0;
      globalThis.fetch=(input,init)=>{
        const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
        if(url.hostname==='edge.microsoft.com'&&url.pathname==='/translate/translatetext') {
          globalThis.__readingFixtureTranslations++;
          return Promise.resolve(new Response(JSON.stringify([{translations:[{text:'我去学校。'}]}]),{status:200,headers:{'content-type':'application/json'}}));
        }
        if(url.protocol==='http:'||url.protocol==='https:') {globalThis.__readingNetworkAttempts.push(url.href);return Promise.reject(new Error('Reading fixture blocked remote network'));}
        return nativeFetch(input,init);
      };
    });
    const extensionId=new URL(background.url()).host;
    const popup=await newPageWithoutForeground(context);
    popup.on('pageerror',error=>report.consoleErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await activateExtensionTabWithoutForeground(context,popup);
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({timeout:15000});
    const initial=await readConfig(popup);
    assert.notEqual(initial.videoSubtitleAppearance?.readingAnnotation,true);
    await persist(popup,{on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,from:'ja',to:'zh-Hans',videoTranslationEnabled:true,videoService:'microsoft',videoServiceDefaultMigrated:true,videoSubtitleVisible:true,videoSubtitleDisplayMode:'original-only',videoSubtitleAppearance:{...initial.videoSubtitleAppearance,readingAnnotation:false},useCache:false});
    // 只预建扩展自己的离屏容器，不请求读音或加载词典；先安装子 Worker 拦截再允许首次开启。
    await background.evaluate(async()=>{
      const documents=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
      if(!documents.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'Reading fixture: intercept dedicated Worker data before execution'});
    });
    readingNetwork=await interceptOffscreenWorkers(context,extensionId,readingData,report);
    report.readingData.fixtureCreatedOffscreen=true;
    const videoPath=path.join(artifactsDir,'fixture.mp4');
    const media=spawnSync(arg('ffmpeg','/opt/homebrew/bin/ffmpeg'),['-y','-f','lavfi','-i','color=c=black:s=320x180:r=1','-t','30','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',videoPath],{encoding:'utf8',timeout:30000});
    assert.equal(media.status,0,media.stderr);
    page=await newPageWithoutForeground(context);
    page.on('pageerror',error=>report.consoleErrors.push(error.message));
    const fixtureUrl='https://www.youtube.com/watch?v=fluentread-reading';
    await page.route(fixtureUrl,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><title>FluentRead 读音标注专项</title><script>var ytInitialPlayerResponse={};</script></head><body style="margin:0;background:#eef2f4"><div id="movie_player" class="html5-video-player" style="position:relative;width:960px;height:540px;margin:24px;background:linear-gradient(130deg,#14252f,#0e1720);color:#fff"><p style="position:absolute;left:28px;top:18px;font:16px system-ui">FluentRead · 日语跟读</p><video class="html5-main-video" muted style="position:absolute;inset:0;width:100%;height:100%;opacity:0"></video><div id="ytp-caption-window-container" style="position:absolute;bottom:90px;left:5%;width:90%;text-align:center;font:30px system-ui"><span class="ytp-caption-segment"></span></div><div class="ytp-right-controls" style="position:absolute;bottom:14px;right:20px;width:300px;height:40px"></div></div></body></html>'}));
    await page.goto(fixtureUrl);await activateExtensionTabWithoutForeground(context,page);
    await page.evaluate(data=>{const video=document.querySelector('video');video.src=data;video.load();},`data:video/mp4;base64,${fs.readFileSync(videoPath).toString('base64')}`);
    await page.locator('#fluent-read-video-subtitle-button').waitFor({timeout:15000});
    const setSource=text=>page.locator('.ytp-caption-segment').evaluate((element,value)=>{element.textContent=value;},text);
    const readLine=()=>page.locator('#fluent-read-video-subtitle-reading').textContent();
    const waitForReading=(predicate,value,options)=>readingNetwork.race(page.waitForFunction(predicate,value,options));
    const assertDownloaded=language=>{
      const requests=report.readingData.requests.filter(request=>request.language===language);
      const expected=dataManifest.filter(file=>file.language===language).map(file=>file.name).sort();
      assert.deepEqual(requests.map(request=>request.name).sort(),expected,`${language}: exactly one request for each fixed pure-data file`);
      assert.ok(requests.every(request=>request.transport==='controlled-worker-runtime-fetch-replay'&&request.mode==='local-replay'),`${language}: every data request must be fulfilled by controlled Worker fetch replay`);
      return requests.length;
    };
    const targets=async()=>{
      const workers=readingNetwork.workers();
      report.lastWorkers=workers.map(({type,url,targetId})=>({type,url,targetId}));
      return workers;
    };
    await setSource('私は学校へ行きます。');
    await page.waitForTimeout(400);
    assert.equal((await targets()).length,0);
    assert.equal(await page.locator('#fluent-read-video-subtitle-reading').count(),0);
    assert.equal(report.readingData.requests.length,0);
    report.cases.push({name:'default-off',passed:true,workerCount:0,dataRequests:0});
    await page.locator('#fluent-read-video-subtitle-button').click();
    const toggle=page.locator('[data-action="toggle-reading-annotation"]');
    const japaneseStarted=performance.now();
    await toggle.click();
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='watashi wa gakkō e ikimasu.',null,{timeout:190000});
    report.japaneseColdDisplayMs=Math.round(performance.now()-japaneseStarted);
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    const coldWorkers=await targets();assert.equal(coldWorkers.length,1);
    const coldWorkerId=coldWorkers[0].targetId;
    assert.equal(assertDownloaded('ja'),12);
    assert.equal(report.readingData.requests.filter(request=>request.language==='hi').length,0);
    report.cases.push({name:'first-japanese-use-downloads-only-twelve-fixed-data-files',passed:true,dataRequests:12});
    assert.equal((await readConfig(popup)).videoSubtitleAppearance.readingAnnotation,true);
    await page.locator('#fluent-read-video-subtitle-button').click();
    await page.locator('#fluent-read-video-subtitle-reading').waitFor({state:'visible'});
    await page.screenshot({path:path.join(artifactsDir,'japanese-original-reading.png')});
    await persist(popup,{videoSubtitleDisplayMode:'bilingual'});
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='watashi wa gakkō e ikimasu.'&&document.querySelector('#fluent-read-video-subtitle')?.textContent==='我去学校。');
    await page.screenshot({path:path.join(artifactsDir,'japanese-bilingual-reading.png')});
    await persist(popup,{videoSubtitleDisplayMode:'original-only'});
    report.cases.push({name:'real-japanese-pipeline-and-menu-save',passed:true,text:await readLine()});
    for(const [language,text,expected] of [['ko','국립 한국어 같이 읽는','gungnip hangugeo gachi ingneun'],['zh-Hant','銀行的音樂','yín háng de yīn yuè'],['ru','Йога и ёлка','Joga i ëlka'],['el','Ευχαριστώ','Efcharistó'],['ar','مُحَمَّد','muḥammad'],['hi','भारत में कमल','bharat mein kamal'],['th','สวัสดีครับ','sawatdi khrap']]) {
      const started=performance.now();
      await persist(popup,{from:language});await setSource(text);
      await waitForReading(expected=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent===expected,expected,{timeout:190000});
      assert.equal(await page.locator('.ytp-caption-segment').textContent(),text);
      assert.equal((await targets()).length,1);
      if(language==='hi')assert.equal(assertDownloaded('hi'),3);
      report.cases.push({name:`real-${language}-pipeline`,passed:true,text:await readLine(),displayMs:Math.round(performance.now()-started)});
    }
    assert.equal(report.readingData.requests.length,15);
    assert.equal(assertDownloaded('ja'),12);assert.equal(assertDownloaded('hi'),3);
    report.cases.push({name:'first-hindi-use-downloads-only-three-fixed-data-files',passed:true,dataRequests:3,remoteExecutableRequests:0});
    await persist(popup,{from:'en'});await setSource('This sentence already uses Latin letters.');
    await waitForReading(()=>!document.querySelector('#fluent-read-video-subtitle-reading')?.textContent);
    await page.locator('#fluent-read-video-subtitle-button').click();
    await waitForReading(()=>document.querySelector('[data-reading-status]')?.hidden===true);
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    await page.locator('#fluent-read-video-subtitle-button').click();
    report.cases.push({name:'unsupported-source-stays-quiet-without-losing-preference',passed:true});
    await persist(popup,{from:'ja'});await setSource('私は学校へ行きます。');
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='watashi wa gakkō e ikimasu.');
    await persist(popup,{videoSubtitleDisplayMode:'translation-only'});
    await waitForReading(()=>!document.querySelector('#fluent-read-video-subtitle-reading')?.textContent);
    assert.equal((await readConfig(popup)).videoSubtitleAppearance.readingAnnotation,true);
    await persist(popup,{videoSubtitleDisplayMode:'original-only'});
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='watashi wa gakkō e ikimasu.');
    report.cases.push({name:'translation-only-hides-and-return-restores',passed:true});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#movie_player').evaluate(el=>{el.style.width='358px';el.style.height='240px';el.style.margin='16px';});
    await setSource('私は学校へ行きます。明日は友達と映画を見ます。これはとても長い字幕の読音表示テストです。');
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent?.includes('ashita'),null,{timeout:15000});
    await page.screenshot({path:path.join(artifactsDir,'japanese-narrow-reading.png')});
    const layout=await page.locator('#fluent-read-video-subtitle-panel').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth,font:getComputedStyle(el).fontSize,overflow:getComputedStyle(el).overflowY}));
    assert.ok(layout.scrollWidth<=layout.width+2,JSON.stringify(layout));
    assert.ok(layout.scroll<=layout.client+2||layout.overflow==='auto',JSON.stringify(layout));
    assert.ok(parseFloat(layout.font)>=16,JSON.stringify(layout));
    report.cases.push({name:'long-narrow-reading',passed:true,layout});
    await page.setViewportSize({width:1280,height:900});
    const options=await newPageWithoutForeground(context);await options.goto(`chrome-extension://${extensionId}/options.html#settings-video`);
    await activateExtensionTabWithoutForeground(context,options);
    const settingsToggle=options.getByRole('switch',{name:'读音标注',exact:true});
    const settingsControl=options.locator('[data-video-subtitle-reading-annotation]');
    await settingsControl.waitFor({state:'visible',timeout:15000});assert.equal(await settingsToggle.getAttribute('aria-checked'),'true');
    await options.screenshot({path:path.join(artifactsDir,'settings-reading.png')});
    await settingsControl.click();await options.close();
    await popup.reload();await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({timeout:15000});
    assert.equal((await readConfig(popup)).videoSubtitleAppearance.readingAnnotation,false);
    await waitForReading(()=>!document.querySelector('#fluent-read-video-subtitle-reading')?.textContent);
    // 在空闲回收等待前取证，避免 MV3 后台休眠后把丢失的网络计数误写为零。
    report.network=await background.evaluate(()=>({blocked:globalThis.__readingNetworkAttempts||[],fixtureTranslationRequests:globalThis.__readingFixtureTranslations||0}));
    await page.waitForTimeout(31000);assert.equal((await targets()).length,0);
    report.cases.push({name:'settings-quick-close-persistence-off-idle-release',passed:true});
    // 选择从未请求过的新原句以避开内容端句子缓存；重建 Worker 后仅从浏览器持久缓存装配引擎。
    report.readingData.networkBlocked=true;
    const downloadCountBeforeOffline=report.readingData.requests.length;
    await persist(popup,{from:'ja'});await setSource('東京大学で日本語を学ぶ。');
    const offlineConfig=await readConfig(popup);
    await persist(popup,{videoSubtitleAppearance:{...offlineConfig.videoSubtitleAppearance,readingAnnotation:true}});
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='tōkyōdaigaku de nihongo o manabu.',null,{timeout:30000});
    const cachedWorkers=await targets();assert.equal(cachedWorkers.length,1);
    assert.notEqual(cachedWorkers[0].targetId,coldWorkerId);
    assert.equal(report.readingData.requests.length,downloadCountBeforeOffline);
    report.cases.push({name:'new-worker-japanese-from-persistent-cache-with-data-network-blocked',passed:true,text:await readLine(),dataRequests:0,workerRecreated:true});
    await setSource('');await persist(popup,{from:'hi'});await setSource('नमस्ते दुनिया');
    await waitForReading(()=>document.querySelector('#fluent-read-video-subtitle-reading')?.textContent==='namaste duniya',null,{timeout:30000});
    assert.equal(report.readingData.requests.length,downloadCountBeforeOffline);
    report.cases.push({name:'new-worker-hindi-from-persistent-cache-with-data-network-blocked',passed:true,text:await readLine(),dataRequests:0});
    assert.deepEqual(report.network.blocked,[]);assert.deepEqual(report.unexpectedNetwork,[]);assert.deepEqual(report.consoleErrors,[]);
    report.passed=true;
  } catch(error) {
    report.error=error.stack||String(error);
    if(page) {
      await page.screenshot({path:path.join(artifactsDir,'failure.png')}).catch(()=>{});
      report.dom=await page.locator('body').innerText().catch(()=> 'page unavailable');
    }
    if(context?.serviceWorkers()[0]) report.network=await context.serviceWorkers()[0].evaluate(()=>({blocked:globalThis.__readingNetworkAttempts||[],fixtureTranslationRequests:globalThis.__readingFixtureTranslations||0})).catch(()=>({backgroundRestarted:true}));
    throw error;
  }
  finally {
    fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));
    try {if(session)await session.close();}finally{if(readingNetwork)await readingNetwork.close();}
    fs.rmSync(profileDir,{recursive:true,force:true});
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
