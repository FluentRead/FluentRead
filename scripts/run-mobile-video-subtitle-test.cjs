#!/usr/bin/env node
'use strict';

// Production-extension browser fixture for #992. Native fullscreen events are
// simulated on Chromium; this does not verify iOS/AVKit rendering or background suspension.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const {guardBrowserClose, getGuardedBrowserPid} = require('./testing/owned-browser-close.cjs');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const suiteFlags = process.argv.slice(2).filter(value=>value==='--suite'||value.startsWith('--suite='));
if(suiteFlags.length>1) throw Error('--suite may be specified only once');
const selectedSuite = suiteFlags[0]?.startsWith('--suite=')?suiteFlags[0].slice('--suite='.length):arg('suite','lifecycle');
if (!['menu','lifecycle','control-clones'].includes(selectedSuite)) throw Error('--suite must be menu, lifecycle or control-clones (default: lifecycle)');
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-mobile-video'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw Error('需要 --playwright-root 和 --focus-safe-helper');
const {chromium} = createRequire(path.join(path.resolve(playwrightRoot), 'mobile-video.cjs'))('playwright');
const helper = require(path.resolve(helperPath));
const source = 'Watch bilingual captions near the bottom.';
const translated = '在视频底部观看双语字幕。';
const url = 'https://m.youtube.com/watch?v=fluentread-mobile-992';
const report = {selectedSuite,fixture:'mobile-youtube-production-extension', evidenceLimits:['local HTML and timedtext fixtures', 'mock translation', 'Chromium viewport/touch emulation', 'isolated-extension-world webkit capability/event shim only; no iOS/AVKit rendering', 'fullscreen geometry uses an explicit DOM property fixture; no system/window fullscreen', 'no live provider or mobile device'], cases:[], errors:[]};
if(selectedSuite==='menu') report.evidenceLimits.push('Explicit menu suite: shared caption readiness, touch/desktop menus and fullscreen geometry only; native-selection shim, video replacement, reload and persisted-pageshow lifecycle assertions are not executed; menu success is not lifecycle acceptance');
if(selectedSuite==='control-clones') Object.assign(report,{fixture:'same-scope-control-clones-production-extension',evidenceLimits:[
  'Local desktop/mobile YouTube HTML, generated media and timedtext fixtures; mock translation',
  'Actual built extension content and native Chromium MutationObserver; no binding import, sync call or cleanup model',
  'Trusted CDP entry/Close clicks on the original live entry; no synthetic click acceptance',
  'Chromium viewport/touch emulation only; no live YouTube, Safari, iOS/AVKit or Safari E2/AX attribution',
  'Private factory call counts are not instrumented; observed live identity and owner uniqueness are checked',
  'No fullscreen/native-track shim, subtitle accuracy or reload/pageshow lifecycle acceptance in this suite',
]});
fs.mkdirSync(artifacts, {recursive:true});
let session, profileDir, page, control, focusMonitor, browserPid, focusTimer, focusError, closing, worker, evaluateBusinessWorld;
let launchAttempted = false, cleanupStarted = false;
const save = () => fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
const closeOwned = async () => {
  if (!session) return;
  closing ||= session.close().then(() => {report.browserCloseReceipt='shared-guard-fulfilled';});
  return closing;
};
const failFocus = error => {
  if (cleanupStarted || focusError) return;
  focusError=error; report.errors.push(error.stack||String(error)); process.exitCode=1; save();
  void closeOwned().catch(error=>{report.cleanupError=String(error);save();});
};
const checkFocus = async () => {
  if(focusError) throw focusError;
  const front=await helper.queryMacFrontmostApplication();
  (report.focusSamples ||= []).push({at:Date.now(),name:front?.name,pid:front?.pid});
  assert.ok(front&&front.pid!==browserPid,'Owned test browser must remain in background');
  if(focusMonitor.error) throw focusMonitor.error;
};

const diagnoseTrackResources = () => page.evaluate(async()=>{
        const results=[];
        for(const beforeAppend of [true,false]){
          const video=document.createElement('video');video.style.display='none';document.body.appendChild(video);
          const node=document.createElement('track');node.kind='subtitles';node.label='Diagnostic';
          const events=[];for(const type of ['load','error'])node.addEventListener(type,()=>events.push({type,cues:node.track.cues?.length,readyState:node.readyState}));
          if(beforeAppend)node.srclang='en';video.appendChild(node);node.track.mode='hidden';if(!beforeAppend)node.srclang='en';
          node.track.addCue(new VTTCue(0,30,'Diagnostic cue'));
          const result={beforeAppend,immediate:node.track.cues?.length,events};
          await new Promise(resolve=>setTimeout(resolve,30));result.afterTask=node.track.cues?.length;
          node.track.addCue(new VTTCue(0,30,'Second cue'));result.afterSecond=node.track.cues?.length;
          node.srclang=node.srclang;await new Promise(resolve=>setTimeout(resolve,30));result.afterSameLanguage=node.track.cues?.length;
          results.push(result);video.remove();
        }
        return results;
});

async function runControlClonesSuite(context, configure, mediaBase64) {
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const manifestBytes = fs.readFileSync(path.join(extensionDir,'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  report.extensionIdentity = {directory:extensionDir,manifestSHA256:hash(manifestBytes),contentScripts:
    [...new Set((manifest.content_scripts||[]).flatMap(entry=>entry.js||[]))].map(file=>{
      const bytes=fs.readFileSync(path.join(extensionDir,file));return {file,sha256:hash(bytes),size:bytes.length};
    })};
  assert.ok(report.extensionIdentity.contentScripts.some(entry=>entry.file==='content-scripts/content.js'),'Require the manifest-declared production content entry');
  const cdp=await context.newCDPSession(page);
  for(const layout of ['desktop','mobile']) {
    await configure({on:true,videoTranslationEnabled:true,videoSubtitleVisible:true,videoSubtitleDisplayMode:'bilingual'});
    await cdp.send('Emulation.setTouchEmulationEnabled',layout==='mobile'?{enabled:true,maxTouchPoints:1}:{enabled:false});
    await page.setViewportSize(layout==='mobile'?{width:390,height:844}:{width:1280,height:900});
    const fixtureUrl=`https://${layout==='mobile'?'m':'www'}.youtube.com/watch?v=fluentread-control-clones-${layout}`;
    const timedtext=`https://${layout==='mobile'?'m':'www'}.youtube.com/api/timedtext?v=fluentread-control-clones-${layout}&lang=en`;
    const controls='<div data-fixture-controls="original" class="'+(layout==='mobile'?'player-controls-bottom player-controls-bottom-right':'ytp-right-controls')+'"><button aria-label="Settings">Settings</button><button aria-label="Full screen">Fullscreen</button></div>';
    const video=`<video playsinline preload="auto" src="data:video/mp4;base64,${mediaBase64}"></video>`;
    const player=`<div id="movie_player" class="html5-video-player${layout==='mobile'?' ytp-mweb-player':''}">${video}<div class="ytp-caption-window-container"><span class="ytp-caption-segment">${source}</span></div>${layout==='desktop'?controls:''}</div>`;
    const topology=layout==='mobile'?`<div id="player-container-id" class="player-container sticky-player">${player}<ytm-custom-control><ytm-watch-player-controls><div id="player-control-overlay"><div class="player-controls-content">${controls}</div></div></ytm-watch-player-controls></ytm-custom-control></div>`:player;
    await page.route(fixtureUrl,route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control clone ownership fixture</title><style>html,body{margin:0;background:#e9edf3;font:16px Arial}#player-container-id,#movie_player{position:relative;width:100%;height:min(56.25vw,500px);background:#101820}video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}[data-fixture-controls]{position:absolute;right:8px;bottom:8px;display:flex;gap:8px;height:44px}[data-fixture-controls] button{min-width:44px;height:44px}[data-fixture-controls="copy"]{bottom:62px}.ytp-caption-window-container{position:absolute;top:35%;color:white}</style><script>var ytInitialPlayerResponse=${JSON.stringify({videoDetails:{videoId:`fluentread-control-clones-${layout}`},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:timedtext,languageCode:'en',name:{simpleText:'English'}}]}}})};</script></head><body>${topology}<p>Controlled production content ownership fixture; not a live mobile site.</p></body></html>`}));
    const timedtextUrl=new URL(timedtext);
    await page.route(candidate=>candidate.origin===timedtextUrl.origin&&candidate.pathname===timedtextUrl.pathname&&
      candidate.searchParams.getAll('v').length===1&&candidate.searchParams.get('v')===timedtextUrl.searchParams.get('v'),
      route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({events:[{tStartMs:0,dDurationMs:30000,segs:[{utf8:source}]}]})}));
    report.stage=`control-clones-${layout}-ready`;save();
    await page.goto(fixtureUrl,{waitUntil:'domcontentloaded'});
    await helper.activateExtensionTabWithoutForeground(context,page);
    await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2&&
      document.querySelector('[data-fixture-controls="original"] #fluent-read-video-subtitle-button')?.getAttribute('data-fluent-read-video-binding-owner')&&
      document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===true);
    const baseline=await page.evaluate(layout=>{
      const live=document.querySelector('[data-fixture-controls="original"] #fluent-read-video-subtitle-button');
      const player=document.querySelector('#movie_player'),host=live.parentElement;
      const scope=layout==='mobile'?document.querySelector('#player-container-id'):player;
      const probe=window.__controlCloneProbe={live,player,host,scope,owner:live.getAttribute('data-fluent-read-video-binding-owner'),
        nativeButtons:[...host.querySelectorAll('button')].filter(node=>node!==live),cases:[],clicks:[]};
      document.addEventListener('click',event=>{
        if(live.contains(event.target))probe.clicks.push({kind:'entry',trusted:event.isTrusted});
        else if(event.target.closest?.('#fluent-read-video-subtitle-menu [data-action="close-menu"]'))probe.clicks.push({kind:'close',trusted:event.isTrusted});
      },true);
      return {layout,url:location.href,liveInOriginalHost:host.matches('[data-fixture-controls="original"]'),scopeContainsHost:scope.contains(host),
        scopeIsPlayer:scope===player,scopeVideoCount:scope.querySelectorAll('video').length,coarsePointer:matchMedia('(pointer:coarse)').matches,
        ariaPressed:live.getAttribute('aria-pressed'),ariaExpanded:live.getAttribute('aria-expanded'),ariaHaspopup:live.getAttribute('aria-haspopup'),ariaControls:live.getAttribute('aria-controls')};
    },layout);
    assert.equal(baseline.url,fixtureUrl);assert.equal(baseline.liveInOriginalHost,true);assert.equal(baseline.scopeContainsHost,true);
    assert.equal(baseline.scopeIsPlayer,layout==='desktop');assert.equal(baseline.scopeVideoCount,1);assert.equal(baseline.coarsePointer,layout==='mobile');
    assert.equal(baseline.ariaPressed,null);assert.equal(baseline.ariaExpanded,'false');assert.equal(baseline.ariaHaspopup,'menu');assert.equal(baseline.ariaControls,'fluent-read-video-subtitle-menu');
    for(const kind of ['whole-host','loose']) {
      report.stage=`control-clones-${layout}-${kind}`;save();await checkFocus();
      const repair=await page.evaluate(async kind=>{
        const p=window.__controlCloneProbe,selector=`button[data-fluent-read-video-binding-owner="${p.owner}"]`;
        const foreign=p.live.cloneNode(true);foreign.setAttribute('data-fluent-read-video-binding-owner',`fixture-foreign-${kind}`);
        const outside=p.live.cloneNode(true),unrelated=document.createElement('div');unrelated.className='html5-video-player';unrelated.hidden=true;
        unrelated.append(document.createElement('video'),outside);document.body.appendChild(unrelated);
        const sibling=kind==='whole-host'?p.host.cloneNode(true):null;
        const copy=sibling?sibling.querySelector(selector):p.live.cloneNode(true);
        if(sibling){sibling.setAttribute('data-fixture-controls','copy');sibling.appendChild(foreign);} else p.scope.appendChild(foreign);
        const records=[],observer=new MutationObserver(batch=>records.push(...batch));observer.observe(p.scope,{childList:true,subtree:true});
        const startedAt=performance.now();
        if(sibling)p.host.parentElement.appendChild(sibling);else p.scope.appendChild(copy);
        const immediateOwnCount=p.scope.querySelectorAll(selector).length;
        // No task, click, locator/sync call or synthetic event can repair the copy before this checkpoint.
        await new Promise(resolve=>queueMicrotask(resolve));
        const afterMicrotask={ownCount:p.scope.querySelectorAll(selector).length,copyConnected:copy.isConnected,elapsedMs:performance.now()-startedAt};
        await new Promise(resolve=>setTimeout(resolve,0));observer.disconnect();
        p.cases.push({kind,copy,foreign,outside,sibling});
        return {kind,immediateOwnCount,afterMicrotask,afterTaskOwnCount:p.scope.querySelectorAll(selector).length,
          removedCopyObserved:records.some(record=>[...record.removedNodes].some(node=>node===copy||node.contains?.(copy))),
          liveIdentity:p.host.querySelector('#fluent-read-video-subtitle-button')===p.live,liveConnected:p.live.isConnected,liveParentUnchanged:p.live.parentElement===p.host,
          nativeButtonsUnchanged:p.nativeButtons.every(node=>node.isConnected&&node.parentElement===p.host),
          siblingRetained:!sibling||sibling.isConnected,siblingNativeRetained:!sibling||Boolean(sibling.querySelector('[aria-label="Full screen"]')),
          foreignRetained:foreign.isConnected,unrelatedRetained:outside.isConnected&&!p.scope.contains(outside),url:location.href};
      },kind);
      const receipt={name:`${layout}-${kind}`,status:'OBSERVED_PENDING_ASSERTIONS',baseline,repair};report.cases.push(receipt);save();
      assert.equal(repair.immediateOwnCount,2,`${layout}/${kind}: fixture must insert a real same-owner copy`);
      assert.equal(repair.afterMicrotask.ownCount,1,JSON.stringify(repair));assert.equal(repair.afterMicrotask.copyConnected,false,JSON.stringify(repair));
      assert.equal(repair.afterTaskOwnCount,1);assert.equal(repair.removedCopyObserved,true);
      for(const key of ['liveIdentity','liveConnected','liveParentUnchanged','nativeButtonsUnchanged','siblingRetained','siblingNativeRetained','foreignRetained','unrelatedRetained'])assert.equal(repair[key],true,`${layout}/${kind}: ${key}`);
      assert.equal(repair.url,fixtureUrl);
      const entry=page.locator('[data-fixture-controls="original"] #fluent-read-video-subtitle-button');
      await entry.click();
      await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===false&&window.__controlCloneProbe.live.getAttribute('aria-expanded')==='true');
      await page.screenshot({path:path.join(artifacts,`control-clones-${layout}-${kind}-menu-open.png`)});
      await page.locator('#fluent-read-video-subtitle-menu [data-action="close-menu"]').click();
      await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===true&&window.__controlCloneProbe.live.getAttribute('aria-expanded')==='false');
      const menu=await page.evaluate(()=>{
        const p=window.__controlCloneProbe;return {focusReturned:document.activeElement===p.live,ariaPressed:p.live.getAttribute('aria-pressed'),
          selectedMode:document.querySelector('#fluent-read-video-subtitle-menu [data-mode][aria-checked="true"]')?.getAttribute('data-mode'),clicks:p.clicks.slice(-2),url:location.href};
      });
      assert.equal(menu.focusReturned,true);assert.equal(menu.ariaPressed,null);assert.equal(menu.selectedMode,'bilingual');assert.equal(menu.url,fixtureUrl);
      assert.deepEqual(menu.clicks,[{kind:'entry',trusted:true},{kind:'close',trusted:true}]);
      Object.assign(receipt,{status:'PASS',menu});save();
      await page.screenshot({path:path.join(artifacts,`control-clones-${layout}-${kind}-menu-closed.png`)});
    }
    fs.writeFileSync(path.join(artifacts,`control-clones-${layout}-dom.html`),await page.evaluate(()=>{
      const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('video').forEach(node=>node.removeAttribute('src'));return clone.outerHTML;
    }));
    // Reuse real configuration persistence/subscription, exercising binding disable without global content disposal.
    await configure({videoTranslationEnabled:false});
    await page.waitForFunction(()=>!window.__controlCloneProbe.live.isConnected&&!document.querySelector('#fluent-read-video-subtitle-menu'));
    const disabled=await page.evaluate(()=>{
      const p=window.__controlCloneProbe;return {liveRemoved:!p.live.isConnected,
        ownCount:p.scope.querySelectorAll(`button[data-fluent-read-video-binding-owner="${p.owner}"]`).length,
        foreignRetained:p.cases.every(item=>item.foreign.isConnected),unrelatedRetained:p.cases.every(item=>item.outside.isConnected),
        nativeButtonsRetained:p.nativeButtons.every(node=>node.isConnected&&node.parentElement===p.host)};
    });
    const disableReceipt={name:`${layout}-configuration-disable`,status:'OBSERVED_PENDING_ASSERTIONS',...disabled};report.cases.push(disableReceipt);save();
    assert.deepEqual(disabled,{liveRemoved:true,ownCount:0,foreignRetained:true,unrelatedRetained:true,nativeButtonsRetained:true});
    disableReceipt.status='PASS';save();
    await page.goto('about:blank'); // Navigation separates fixtures; this is not a reload/unload-cleanup assertion.
  }
  await configure({on:false});
  assert.equal(report.errors.length,0,report.errors.join('\n'));
  report.stage='control-clones-complete';save();
}

async function main() {
  assert.ok(fs.existsSync(path.join(extensionDir,'manifest.json')), '需要 production 扩展构建');
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-mobile-video-'));
  const media = path.join(artifacts,'fixture.mp4');
  const generated = spawnSync(arg('ffmpeg','/opt/homebrew/bin/ffmpeg'), ['-y','-f','lavfi','-i','color=c=0x263c52:s=640x360:r=1','-t','30','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',media], {encoding:'utf8', timeout:30000});
  assert.equal(generated.status,0,generated.stderr);
  const mediaBase64 = fs.readFileSync(media).toString('base64');
  focusMonitor=helper.startFocusEventMonitor({onEvent(event){
    report.focusEvents=[...focusMonitor.events]; save();
    if(browserPid&&event.pid===browserPid) failFocus(Error('Owned test browser activated during focus observation'));
  },onError:failFocus});
  report.focusObserver=await focusMonitor.ready;
  launchAttempted=true;
  session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
    browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    headless:false, background:true, displayTarget:'secondary', viewport:{width:1280,height:900},
    browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
  guardBrowserClose(session,profileDir);
  browserPid=await getGuardedBrowserPid(session); report.browserPid=browserPid;
  assert.ok(!focusMonitor.events.some(event=>event.pid===browserPid),'Browser became foreground during launch');
  await checkFocus();
  let checking=false;
  focusTimer=setInterval(()=>{if(checking||cleanupStarted)return;checking=true;void checkFocus().catch(failFocus).finally(()=>{checking=false;});},500);
  const {context}=session;
  context.setDefaultTimeout(15000);
  context.browser().on('disconnected',()=>{if(!cleanupStarted&&!closing)failFocus(Error('Owned browser disconnected before validation completed'));});
  Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});
  assert.equal(report.launchMode,'macos-background-cdp'); assert.equal(report.focusPolicy,'launchservices-no-foreground');
  assert.equal(report.windowPlacement?.mode,'background-visible-no-focus'); assert.equal(report.windowPlacement?.browserFrontmost,false);
  worker = context.serviceWorkers().find(w=>w.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/background.js'),timeout:30000});
  worker.on('console',message=>(report.workerConsole ||= []).push({type:message.type(),text:message.text()}));
  await worker.evaluate(text=>{
    globalThis.__mobileVideoRequests=[];
    const original=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const url=String(input?.url||input);
      if(url.startsWith('https://edge.microsoft.com/translate/translatetext')){
        globalThis.__mobileVideoRequests.push({url,source:init?.body});
        return new Response(JSON.stringify([{translations:[{text}]}]),{status:200,headers:{'content-type':'application/json'}});
      }
      return original(input,init);
    };
  },translated);
  control=await helper.newPageWithoutForeground(context);
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`,{waitUntil:'domcontentloaded'});
  const configure=async(patch)=>{
    const result=await control.evaluate(async(patch)=>{
      const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
      const current=typeof read?.value==='string'?JSON.parse(read.value):(read?.value||{});
      return chrome.runtime.sendMessage({type:'persistConfig',clientId:'mobile-video-992',sequence:Date.now(),config:{...current,...patch},...(Number.isSafeInteger(current.__fluentConfigRevision)?{baseRevision:current.__fluentConfigRevision}:{})});
    },patch);
    assert.equal(result?.success,true,JSON.stringify(result));
  };
  await configure({on:true,from:'en',to:'zh-Hans',videoTranslationEnabled:true,videoService:'microsoft',videoServiceDefaultMigrated:true,videoSubtitleVisible:true,videoSubtitleDisplayMode:'bilingual',videoPreferHumanSubtitles:false,useCache:false});
  page=await helper.newPageWithoutForeground(context);
  page.on('pageerror',error=>report.errors.push(error.stack||String(error)));
  await page.addInitScript(()=>{
    window.__nativeTrackResourceEvents=[];
    document.addEventListener('error',event=>{
      const node=event.target;
      if(!(node instanceof HTMLTrackElement)||!node.hasAttribute('data-fluent-read-native-subtitles'))return;
      const entry={type:event.type,trusted:event.isTrusted,before:node.track.cues?.length,at:performance.now()};
      window.__nativeTrackResourceEvents.push(entry);
      setTimeout(()=>{entry.afterTask=node.track.cues?.length;entry.elapsedMs=performance.now()-entry.at;},0);
    },true);
  });
  page.on('console',message=>(report.console ||= []).push({type:message.type(),text:message.text()}));
  page.on('requestfailed',request=>(report.requestFailures ||= []).push({url:request.url().slice(0,300),failure:request.failure()}));
  page.on('response',response=>{if(response.url().includes('/api/timedtext'))(report.timedtextResponses ||= []).push({url:response.url(),status:response.status()});});
  if(selectedSuite==='control-clones'){await runControlClonesSuite(context,configure,mediaBase64);return;}
  const timedtext='https://m.youtube.com/api/timedtext?v=fluentread-mobile-992&lang=en';
  await page.route('**/api/timedtext**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({events:[{tStartMs:0,dDurationMs:30000,segs:[{utf8:source}]}]})}));
  await page.route(url,route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Mobile YouTube subtitle fixture</title><style>html,body{margin:0;background:#e9edf3;font:16px Arial}#movie_player{position:relative;width:100%;height:min(56.25vw,100svh);aspect-ratio:16/9;background:#101820;overflow:hidden}video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.ytp-caption-window-container{position:absolute;left:0;right:0;top:45%;text-align:center;color:white}.ytp-caption-segment{background:#000b}.ytp-right-controls{position:absolute;right:8px;bottom:8px;height:32px;display:flex;gap:8px}.ytp-right-controls button{height:32px;background:#223345;color:white}.controls-hidden .ytp-right-controls{opacity:0;pointer-events:none}#description{padding:20px;line-height:1.6}</style><script>var ytInitialPlayerResponse=${JSON.stringify({videoDetails:{videoId:'fluentread-mobile-992'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:timedtext,languageCode:'en',name:{simpleText:'English'}}]}}})};</script></head><body><div id="movie_player" class="html5-video-player controls-hidden"><video playsinline preload="auto" src="data:video/mp4;base64,${mediaBase64}"></video><div id="ytp-caption-window-container" class="ytp-caption-window-container"><span class="ytp-caption-segment">${source}</span></div><div class="ytp-right-controls"><button aria-label="Settings">Settings</button><button aria-label="Fullscreen">Fullscreen</button></div></div><div id="description">Mobile YouTube layout fixture<br>生产扩展字幕定位与系统轨道接口专项<br>不是移动真机验收</div></body></html>`}));
  const activate=()=>helper.activateExtensionTabWithoutForeground(context,page);
  await page.setViewportSize({width:390,height:844});
  const cdp=await context.newCDPSession(page);
  const worlds=new Map();
  cdp.on('Runtime.executionContextCreated',({context})=>worlds.set(context.id,context));
  cdp.on('Runtime.executionContextDestroyed',({executionContextId})=>worlds.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared',()=>worlds.clear());
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  let isolatedWorld;
  const isolated=async expression=>{
    assert.ok(isolatedWorld,'Extension isolated world must be identified first');
    const result=await cdp.send('Runtime.evaluate',{contextId:isolatedWorld,expression,returnByValue:true,awaitPromise:true});
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;
  };
  evaluateBusinessWorld=isolated;
  const installNativeShim=async()=>{
    isolatedWorld=undefined;
    const extensionId=new URL(worker.url()).host;
    const frame=(await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    for(let attempt=0;attempt<50&&!isolatedWorld;attempt++){
      for(const world of worlds.values()){
        if(world.auxData?.isDefault||world.auxData?.frameId!==frame) continue;
        try {
          const result=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'globalThis.chrome?.runtime?.id',returnByValue:true});
          if(result.result.value===extensionId){isolatedWorld=world.id;break;}
        }catch{/* A navigation can destroy a candidate context before inspection. */}
      }
      if(!isolatedWorld)await page.waitForTimeout(100);
    }
    assert.ok(isolatedWorld,'Unable to locate the production extension isolated world');
    const verified=await isolated(`(()=>{
      Object.defineProperty(HTMLVideoElement.prototype,'webkitEnterFullscreen',{configurable:true,value(){Object.defineProperty(this,'webkitDisplayingFullscreen',{value:true,configurable:true});this.dispatchEvent(new Event('webkitbeginfullscreen'));}});
      Object.defineProperty(HTMLVideoElement.prototype,'webkitExitFullscreen',{configurable:true,value(){Object.defineProperty(this,'webkitDisplayingFullscreen',{value:false,configurable:true});this.dispatchEvent(new Event('webkitendfullscreen'));}});
      return {extensionId:chrome.runtime.id,method:typeof document.querySelector('video').webkitEnterFullscreen};
    })()`);
    assert.equal(verified.extensionId,extensionId);assert.equal(verified.method,'function');
    (report.nativeShimWorlds ||= []).push({...verified,contextId:isolatedWorld});
  };
  await page.goto(url,{waitUntil:'domcontentloaded'}); await activate(); await installNativeShim();
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  const ready=()=>page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle')?.textContent?.includes('在视频底部')&&document.querySelector('track[data-fluent-read-native-subtitles]')?.track.cues?.length>0,null,{timeout:20000});
  report.trackDiagnostics=await diagnoseTrackResources();
  report.stage='initial-ready'; save();
  await ready();
  report.nativeResourceEvents=await page.evaluate(()=>window.__nativeTrackResourceEvents||[]);
  assert.ok(report.nativeResourceEvents.some(event=>event.trusted&&event.before===0&&event.afterTask>0),'Native HTMLTrack resource error must recover before the following timer task');
  const capture=async(name)=>{
    await checkFocus();
    const value=await page.evaluate(()=>{
      const rect=el=>{const r=el?.getBoundingClientRect();return r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null;};
      const panel=document.querySelector('#fluent-read-video-subtitle-panel');const track=document.querySelector('track[data-fluent-read-native-subtitles]');
      return {video:rect(document.querySelector('video')),panel:rect(panel),original:document.querySelector('#fluent-read-video-subtitle-original')?.textContent,translation:document.querySelector('#fluent-read-video-subtitle')?.textContent,nativeMode:track?.track.mode,nativeCues:Array.from(track?.track.cues||[]).map(c=>({start:c.startTime,end:c.endTime,text:c.text})),coarsePointer:matchMedia('(pointer:coarse)').matches,viewport:{width:innerWidth,height:innerHeight}};
    });
    report.cases.push({name,...value}); await page.screenshot({path:path.join(artifacts,`${name}.png`)}); return value;
  };
  const portrait=await capture('portrait-inline');
  assert.ok(portrait.panel.bottom>=portrait.video.bottom-18&&portrait.panel.bottom<=portrait.video.bottom,JSON.stringify(portrait));
  assert.equal(portrait.nativeMode,'hidden'); assert.match(portrait.nativeCues[0].text,/在视频底部/);
  assert.match(portrait.original,/Watch bilingual/);
  await page.evaluate(()=>document.querySelector('#movie_player').classList.remove('controls-hidden'));
  await page.waitForTimeout(1200); const controls=await capture('portrait-visible-controls');
  assert.ok(controls.panel.bottom<=controls.video.bottom-42,JSON.stringify(controls));
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===false);
  assert.ok(await page.locator('[data-native-fullscreen-hint]').isVisible());
  const targets=await page.locator('#fluent-read-video-subtitle-menu button, #fluent-read-video-subtitle-button').evaluateAll(nodes=>nodes.filter(n=>{
    const style=getComputedStyle(n);
    return !n.closest('[hidden]')&&n.getClientRects().length>0&&style.visibility==='visible'&&Number(style.opacity)>0;
  }).map(n=>({action:n.dataset.action||n.dataset.mode||n.id,label:n.getAttribute('aria-label')||n.textContent.trim(),height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})));
  report.touchTargets=targets;
  assert.equal(portrait.coarsePointer,true,'The controlled touch fixture must actually enable coarse-pointer CSS');
  if(portrait.coarsePointer) assert.ok(targets.length>0&&targets.every(t=>t.height>=44&&t.width>=44),JSON.stringify(targets));
  await capture('portrait-menu');
  const captureMenuScrollTargets=async(name,includeTiming,includeFocused=false)=>{
    await checkFocus();
    const geometry=await page.evaluate(({includeTiming,includeFocused})=>{
      const menu=document.querySelector('#fluent-read-video-subtitle-menu');
      const header=menu.querySelector('.fluent-read-video-menu-title');
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const viewport=window.visualViewport;
      const visibleViewport={left:viewport?.offsetLeft||0,top:viewport?.offsetTop||0,
        right:(viewport?.offsetLeft||0)+(viewport?.width||innerWidth),bottom:(viewport?.offsetTop||0)+(viewport?.height||innerHeight)};
      const visibleRect=node=>{
        const bounds={...rect(node)};
        for(let ancestor=node.parentElement;ancestor;ancestor=ancestor.parentElement){
          const style=getComputedStyle(ancestor),clipX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX),clipY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
          if(!clipX&&!clipY)continue;
          const r=rect(ancestor),sx=r.width/(ancestor.offsetWidth||r.width)||1,sy=r.height/(ancestor.offsetHeight||r.height)||1;
          const left=r.left+ancestor.clientLeft*sx,top=r.top+ancestor.clientTop*sy;
          if(clipX){bounds.left=Math.max(bounds.left,left);bounds.right=Math.min(bounds.right,left+ancestor.clientWidth*sx);}
          if(clipY){bounds.top=Math.max(bounds.top,top);bounds.bottom=Math.min(bounds.bottom,top+ancestor.clientHeight*sy);}
        }
        bounds.left=Math.max(bounds.left,visibleViewport.left);bounds.top=Math.max(bounds.top,visibleViewport.top);
        bounds.right=Math.min(bounds.right,visibleViewport.right);bounds.bottom=Math.min(bounds.bottom,visibleViewport.bottom);
        return {...bounds,width:Math.max(0,bounds.right-bounds.left),height:Math.max(0,bounds.bottom-bounds.top)};
      };
      const headerVisible=visibleRect(header);
      const menuFrame=rect(menu),menuPaddingTop=parseFloat(getComputedStyle(menu).paddingTop)||0;
      const menuClipTop=menuFrame.top+menu.clientTop*(menuFrame.height/(menu.offsetHeight||menuFrame.height)||1);
      const headerTopHits=[.25,.5,.75].map(fraction=>{
        const x=headerVisible.left+headerVisible.width*fraction,y=menuClipTop+1,hit=document.elementFromPoint(x,y);
        return {x,y,hitOwnedHeader:hit===header||Boolean(hit&&header.contains(hit)),hitTag:hit?.tagName||null};
      });
      const actions=['close-menu',...(includeTiming?['subtitle-earlier','subtitle-later']:[])];
      const targets=actions.map(action=>({action,matches:[...menu.querySelectorAll(`[data-action="${action}"]`)]}));
      if(includeFocused){
        const active=document.activeElement;
        targets.push({action:'focused',matches:active instanceof HTMLButtonElement&&menu.contains(active)?[active]:[]});
      }
      return {menu:menuFrame,menuPaddingTop,menuClipTop,header:rect(header),headerVisible,headerTopHits,headerBackground:getComputedStyle(header).backgroundColor,visualViewport:visibleViewport,scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,
        timingRow:includeTiming?rect(menu.querySelector('[data-timing-row]')):null,
        targets:targets.map(({action,matches})=>{
          const node=matches[0];
          if(!node)return {action,count:0};
          const frame=rect(node),visible=visibleRect(node);
          const points=[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>{
            const px=frame.left+frame.width*x,py=frame.top+frame.height*y,hit=document.elementFromPoint(px,py);
            return {x:px,y:py,hitOwnedControl:hit===node||Boolean(hit&&node.contains(hit)),hitTag:hit?.tagName||null,hitAction:hit?.closest('[data-action]')?.getAttribute('data-action')||null};
          });
          return {action,count:matches.length,actualAction:node.dataset.action||null,actualMode:node.dataset.mode||null,inHeader:header.contains(node),frame,visible,fullyVisible:visible.left<=frame.left+.01&&visible.top<=frame.top+.01&&visible.right>=frame.right-.01&&visible.bottom>=frame.bottom-.01,points};
        })};
    },{includeTiming,includeFocused});
    (report.menuScrollTargets ||= []).push({name,...geometry});save();
    // Capture the observed scroll position before any input or assertion; locator.click() would auto-scroll it.
    await page.screenshot({path:path.join(artifacts,`${name}.png`)});
    return geometry;
  };
  const assertWholeMenuTarget=(name,target,minSize=44)=>{
    assert.equal(target.count,1,`${name}: actual target must be unique ${JSON.stringify(target)}`);
    assert.ok(target.frame.width>=minSize&&target.frame.height>=minSize&&target.visible.width>=minSize-.01&&target.visible.height>=minSize-.01&&target.fullyVisible,
      `${name}: full${minSize}px target clipped by menu/player/viewport ${JSON.stringify(target)}`);
    assert.ok(target.points.length===5&&target.points.every(point=>point.hitOwnedControl),`${name}: actual five-point target hit failed ${JSON.stringify(target)}`);
  };
  const assertMenuHeaderTop=(name,geometry)=>{
    if(geometry.scrollTop<geometry.menuPaddingTop)return;
    assert.ok(geometry.headerVisible.top<=geometry.menuClipTop+.01&&geometry.headerTopHits.length===3&&geometry.headerTopHits.every(point=>point.hitOwnedHeader),
      `${name}: scrolled content leaks above the current menu header ${JSON.stringify(geometry)}`);
  };
  const timingGeometry=await page.evaluate(()=>{
    const menu=document.querySelector('#fluent-read-video-subtitle-menu');
    const row=menu.querySelector('[data-timing-row]');
    menu.scrollTop+=Math.max(0,row.getBoundingClientRect().bottom-menu.getBoundingClientRect().bottom+8);
    const label=row.querySelector('.fluent-read-video-menu-row-label');
    const controls=row.querySelector('.fluent-read-video-menu-timing-controls');
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const style=getComputedStyle(label);
    return {menu:rect(menu),row:rect(row),label:rect(label),controls:rect(controls),modes:rect(menu.querySelector('[data-mode]').parentElement),labelText:label.textContent,labelWidth:label.clientWidth,labelScrollWidth:label.scrollWidth,labelHeight:label.clientHeight,labelScrollHeight:label.scrollHeight,overflow:style.overflow,textOverflow:style.textOverflow,contain:style.contain,offset:controls.querySelector('[data-subtitle-offset]').textContent};
  });
  report.timingGeometry=timingGeometry;
  const timingTargets=await captureMenuScrollTargets('portrait-menu-timing-targets',true);
  assert.equal(timingGeometry.labelText,'字幕时间');
  assert.ok(timingGeometry.row.top>=timingGeometry.modes.bottom-1,'Touch timing group must use its own row');
  assert.ok(timingGeometry.row.top>=timingGeometry.menu.top&&timingGeometry.row.bottom<=timingGeometry.menu.bottom,JSON.stringify(timingGeometry));
  assert.ok(timingGeometry.labelScrollWidth<=timingGeometry.labelWidth+1&&timingGeometry.labelScrollHeight<=timingGeometry.labelHeight+1,JSON.stringify(timingGeometry));
  assert.notEqual(timingGeometry.textOverflow,'ellipsis');assert.equal(timingGeometry.contain,'none');
  assert.ok(timingGeometry.controls.left>=timingGeometry.row.left&&timingGeometry.controls.right<=timingGeometry.row.right,JSON.stringify(timingGeometry));
  assert.ok(timingGeometry.label.right<=timingGeometry.controls.left+1||timingGeometry.label.bottom<=timingGeometry.controls.top+1,'Timing label and controls must not overlap');
  assert.match(timingGeometry.offset,/0\.0\s*s/);
  await page.screenshot({path:path.join(artifacts,'portrait-menu-timing.png')});
  const hintGeometry=await page.evaluate(()=>{
    const menu=document.querySelector('#fluent-read-video-subtitle-menu');
    menu.scrollTop=menu.scrollHeight;
    const bounds=menu.getBoundingClientRect();
    const hint=menu.querySelector('[data-native-fullscreen-hint]').getBoundingClientRect();
    return {menuTop:bounds.top,menuBottom:bounds.bottom,hintTop:hint.top,hintBottom:hint.bottom,scrollTop:menu.scrollTop};
  });
  const hintTargets=await captureMenuScrollTargets('portrait-menu-hint-targets',false);
  assert.ok(hintGeometry.hintTop>=hintGeometry.menuTop&&hintGeometry.hintBottom<=hintGeometry.menuBottom,JSON.stringify(hintGeometry));
  report.nativeHintGeometry=hintGeometry;
  for(const [name,geometry] of [['timing',timingTargets],['hint',hintTargets]]){
    assert.ok(geometry.scrollHeight>geometry.clientHeight&&geometry.scrollTop>0,`${name}: fixture must exercise actual menu overflow and scrolling ${JSON.stringify(geometry)}`);
    assertMenuHeaderTop(name,geometry);
    for(const target of geometry.targets)assertWholeMenuTarget(name,target);
  }
  assert.ok(timingTargets.headerVisible.height===0||timingTargets.timingRow.top>=timingTargets.headerVisible.bottom-.01,
    `Timing row is covered by the current menu header ${JSON.stringify(timingTargets)}`);
  await capture('portrait-menu-hint');
  const closeCenter=hintTargets.targets.find(target=>target.action==='close-menu').points[0];
  report.normalMenuClose={input:'mouse.click-at-observed-checked-center',x:closeCenter.x,y:closeCenter.y};save();
  await page.mouse.click(closeCenter.x,closeCenter.y);
  await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===true);
  const entry=page.locator('#fluent-read-video-subtitle-button');
  assert.equal(await entry.evaluate(node=>node===document.activeElement),true,'Normal Close after scrolling must return focus to the same player entry');
  report.normalMenuClose.focusReturned=true;
  await capture('portrait-menu-normal-close');
  await entry.click();
  await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===false);
  const keyboardSteps=[
    ['End','download-bilingual-subtitles'],
    ['ArrowUp','download-translated-subtitles'],['ArrowUp','download-subtitles'],
    ['ArrowUp','subtitle-later'],['ArrowUp','subtitle-earlier'],
    ['ArrowUp','off'],['ArrowUp','original-only'],['ArrowUp','translation-only'],['ArrowUp','bilingual'],
    ['ArrowUp','open-sentence-learning'],['ArrowUp','close-menu'],['Home','open-settings'],
  ];
  for(const [index,[key,expected]] of keyboardSteps.entries()){
    await page.keyboard.press(key);
    const name=`portrait-menu-keyboard-${index+1}-${key}`;
    const geometry=await captureMenuScrollTargets(name,false,true);
    const focused=geometry.targets.find(target=>target.action==='focused');
    (report.menuKeyboardSteps ||= []).push({key,expected,observed:focused.actualAction||focused.actualMode});save();
    assert.equal(focused.actualAction||focused.actualMode,expected,`${name}: trusted key must focus the expected actual control`);
    assertMenuHeaderTop(name,geometry);
    for(const target of geometry.targets)assertWholeMenuTarget(name,target);
    assert.ok(focused.inHeader||geometry.headerVisible.height===0||focused.frame.top>=geometry.headerVisible.bottom-.01,
      `${name}: focused body control is covered by the menu header ${JSON.stringify(focused)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===true);
  assert.equal(await entry.evaluate(node=>node===document.activeElement),true,'Escape after reopening must return focus to the same player entry');
  await page.setViewportSize({width:844,height:390});
  await page.waitForTimeout(1200);const landscape=await capture('landscape-inline');
  assert.ok(landscape.panel.left>=landscape.video.left&&landscape.panel.right<=landscape.video.right,JSON.stringify(landscape));
  assert.ok(landscape.video.bottom<=landscape.viewport.height&&landscape.panel.bottom<=landscape.viewport.height,JSON.stringify(landscape));
  try {
    await cdp.send('Emulation.setSafeAreaInsets', {insets:{top:0,left:44,bottom:24,right:44}});
    report.safeAreaEmulation={supported:true,insets:{left:44,right:44,bottom:24}};
  } catch(error) {
    report.safeAreaEmulation={supported:false,reason:String(error)};
  }
  // Exercise the production fullscreen geometry branch without changing the
  // browser's native window state or display placement.
  await isolated(`Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>document.querySelector('#movie_player')})`);
  await page.evaluate(()=>{const player=document.querySelector('#movie_player');player.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;aspect-ratio:auto;';document.dispatchEvent(new Event('fullscreenchange'));});
  await page.waitForTimeout(1200);
  const safe=await capture('fullscreen-geometry-safe-area');
  const side=report.safeAreaEmulation.supported?44:12;
  assert.ok(safe.panel.left>=side-1&&safe.panel.right<=safe.viewport.width-side+1,JSON.stringify(safe));
  if(report.safeAreaEmulation.supported) assert.ok(safe.panel.bottom<=safe.viewport.height-24+1,JSON.stringify(safe));
  await isolated(`delete document.fullscreenElement`);
  await page.evaluate(()=>{document.querySelector('#movie_player').removeAttribute('style');document.dispatchEvent(new Event('fullscreenchange'));});
  if(report.safeAreaEmulation.supported) await cdp.send('Emulation.setSafeAreaInsets',{insets:{top:0,left:0,bottom:0,right:0}});
  const runDesktopMenu=async()=>{
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await page.setViewportSize({width:1280,height:900});
    const desktopCapabilities=await page.evaluate(()=>({coarsePointer:matchMedia('(pointer:coarse)').matches,maxTouchPoints:navigator.maxTouchPoints}));
    report.desktopMenu={capabilities:desktopCapabilities,minimumTargetSize:22,keyboardSteps:[]};save();
    assert.equal(desktopCapabilities.coarsePointer,false,'Desktop section must actually leave coarse-pointer CSS');
    assert.equal(desktopCapabilities.maxTouchPoints,0,'Desktop section must actually disable touch emulation');
    await page.evaluate(()=>document.querySelector('#movie_player').classList.remove('controls-hidden'));
    await entry.click();
    await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===false);
    const desktopOpen=await captureMenuScrollTargets('desktop-menu-open',false,true);
    assert.ok(desktopOpen.header.height<=28,`Desktop header must retain its existing compact size ${JSON.stringify(desktopOpen.header)}`);
    for(const target of desktopOpen.targets)assertWholeMenuTarget('desktop-open',target,22);
    for(const [key,expected] of [['End','download-bilingual-subtitles'],['Home','open-settings']]){
      await page.keyboard.press(key);
      const name=`desktop-menu-keyboard-${key}`,geometry=await captureMenuScrollTargets(name,false,true);
      const focused=geometry.targets.find(target=>target.action==='focused');
      report.desktopMenu.keyboardSteps.push({key,expected,observed:focused.actualAction||focused.actualMode});save();
      assert.equal(focused.actualAction||focused.actualMode,expected,`${name}: trusted key must focus the expected actual control`);
      for(const target of geometry.targets)assertWholeMenuTarget(name,target,22);
      assertMenuHeaderTop(name,geometry);
      assert.ok(focused.inHeader||geometry.headerVisible.height===0||focused.frame.top>=geometry.headerVisible.bottom-.01,
        `${name}: focused body control is covered by the menu header ${JSON.stringify(focused)}`);
    }
    const desktopClose=await captureMenuScrollTargets('desktop-menu-before-close',false);
    const desktopCloseTarget=desktopClose.targets[0];assertWholeMenuTarget('desktop-close',desktopCloseTarget,22);
    await page.mouse.click(desktopCloseTarget.points[0].x,desktopCloseTarget.points[0].y);
    await page.waitForFunction(()=>document.querySelector('#fluent-read-video-subtitle-menu')?.hidden===true);
    assert.equal(await entry.evaluate(node=>node===document.activeElement),true,'Desktop normal Close must return focus to the same player entry');
    report.desktopMenu.normalCloseFocusReturned=true;
    await capture('desktop-menu-normal-close');
  };
  const disableAndCheckCleanup=async()=>{
    await configure({on:false});await page.waitForFunction(()=>!document.querySelector('#fluent-read-video-subtitle-layer')&&!document.querySelector('track[data-fluent-read-native-subtitles]'));
    await capture('disabled-cleanup');
    assert.equal(report.errors.length,0,report.errors.join('\n'));
  };
  if(selectedSuite==='menu'){
    report.nativeSystemSelectionShim={status:'NOT_RUN_EXPLICIT_MENU_SUITE',scope:'Native selection lifecycle is excluded; shared fullscreen geometry remains a controlled DOM fixture'};save();
    await runDesktopMenu();
    await disableAndCheckCleanup();
    return;
  }
  report.nativeSystemSelectionShim={scope:'Explicit standard TextTrack.mode writes emulate system-menu selections on Chromium; not native AVKit selection or rendering',selectionChanges:[]};
  // Subscribe before each selection write. Only an actual browser change event
  // acknowledges selection; cue counts and fixed sleeps are not selection ACKs.
  const selectNativeTracks=async(name,desired)=>{
    const receipt=await page.evaluate(({name,desired})=>new Promise((resolve,reject)=>{
      const video=document.querySelector('video'),list=video.textTracks;
      const owned=document.querySelector('track[data-fluent-read-native-subtitles]')?.track;
      const refs={site:window.__siteTrack,owned,other:window.__otherSiteTrack};
      const modes=()=>Array.from(list).map(track=>({kind:track.kind,label:track.label,mode:track.mode}));
      const matches=()=>Object.entries(desired).every(([key,mode])=>refs[key]?.mode===mode);
      const before=modes(),events=[],startedAt=performance.now(),deadline=startedAt+2000;
      let settled=false,timer,afterEvent;
      const cleanup=()=>{clearTimeout(timer);clearTimeout(afterEvent);list.removeEventListener('change',onChange);};
      const fail=message=>{if(settled)return;settled=true;cleanup();reject(Error(JSON.stringify({name,message,before,desired,events,after:modes()})));};
      const onChange=event=>{
        events.push({type:event.type,isTrusted:event.isTrusted,elapsedMs:performance.now()-startedAt,tracks:modes()});
        if(!event.isTrusted)return fail('Selection ACK must be a trusted browser change event');
        if(!matches()||afterEvent!==undefined)return;
        // Finish after dispatch, including the production bridge listeners.
        afterEvent=setTimeout(()=>{
          if(performance.now()>=deadline)return fail('change ACK exceeded absolute deadline');
          if(!matches())return fail('selection changed before post-dispatch ACK');
          settled=true;cleanup();resolve({name,before,desired,events,after:modes(),elapsedMs:performance.now()-startedAt});
        },0);
      };
      list.addEventListener('change',onChange);
      timer=setTimeout(()=>fail('No actual TextTrackList.change ACK within 2000ms'),2000);
      try{
        if(!Object.keys(desired).every(key=>refs[key]))return fail('Required track missing');
        if(matches())return fail('Selection setup made no mode transition');
        for(const [key,mode] of Object.entries(desired))refs[key].mode=mode;
      }catch(error){fail(String(error));}
    }),{name,desired});
    report.nativeSystemSelectionShim.selectionChanges.push(receipt);save();
  };
  await page.evaluate(()=>{
    const video=document.querySelector('video');const track=video.addTextTrack('captions','Site captions','en');
    track.addCue(new VTTCue(0,30,'Site caption'));window.__siteTrack=track;
    window.__nativeBridgeNode=document.querySelector('track[data-fluent-read-native-subtitles]');
  });
  await selectNativeTracks('initial-site-A',{site:'showing'});
  await isolated(`document.querySelector('video').webkitEnterFullscreen()`);
  await page.waitForFunction(()=>document.querySelector('track[data-fluent-read-native-subtitles]')?.track.mode==='hidden');
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'showing','Entering the native interface must preserve the site selection');
  await capture('native-interface-enter');
  report.nativeSystemSelectionShim.beginPreservedSiteSelection=true;
  // A -> FluentRead -> leave restores A, without an intervening Off choice.
  await selectNativeTracks('A-to-FluentRead-direct',{site:'disabled',owned:'showing'});
  await isolated(`document.querySelector('video').webkitExitFullscreen()`);
  await page.waitForFunction(()=>document.querySelector('track[data-fluent-read-native-subtitles]')?.track.mode==='hidden');
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'showing','Direct A to FluentRead must restore A on leave');
  report.nativeSystemSelectionShim.directSourceRestored=true;
  // A -> FluentRead -> Off -> FluentRead must not revive obsolete A.
  await isolated(`document.querySelector('video').webkitEnterFullscreen()`);
  await selectNativeTracks('A-to-FluentRead-before-Off',{site:'disabled',owned:'showing'});
  const countBeforeOff=await page.evaluate(()=>window.__nativeBridgeNode.track.cues.length);
  await selectNativeTracks('system-Off',{owned:'disabled'});
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.__nativeBridgeNode.track.mode),'disabled');
  assert.equal(await page.evaluate(()=>document.querySelector('track[data-fluent-read-native-subtitles]')===window.__nativeBridgeNode),true,'Off must preserve the owned track identity');
  await selectNativeTracks('Off-to-FluentRead',{owned:'showing'});
  // Cue readiness remains a separate assertion after the real change ACK.
  await page.waitForFunction(count=>window.__nativeBridgeNode.track.cues?.length===count,countBeforeOff);
  await isolated(`document.querySelector('video').webkitExitFullscreen()`);
  await page.waitForFunction(()=>window.__nativeBridgeNode.track.mode==='hidden');
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'disabled','Off followed by FluentRead must not restore obsolete A on leave');
  report.nativeSystemSelectionShim.offThenFluentReadKeptSourceDisabled=true;
  // Off -> leave/re-enter must neither restore A nor auto-select FluentRead.
  await isolated(`document.querySelector('video').webkitEnterFullscreen()`);
  await selectNativeTracks('FluentRead-before-Off-reentry',{site:'disabled',owned:'showing'});
  await selectNativeTracks('Off-before-leave',{owned:'disabled'});
  await isolated(`document.querySelector('video').webkitExitFullscreen()`);
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'disabled','Leaving after Off must not restore an earlier site selection');
  await isolated(`document.querySelector('video').webkitEnterFullscreen()`);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.__nativeBridgeNode.track.mode),'hidden');
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'disabled');
  report.nativeSystemSelectionShim.offPreservedAcrossReentry=true;
  await isolated(`document.querySelector('video').webkitExitFullscreen()`);
  await page.evaluate(()=>{
    const other=document.querySelector('video').addTextTrack('captions','Other site captions','en');
    other.addCue(new VTTCue(0,30,'Other site caption'));window.__otherSiteTrack=other;
  });
  await selectNativeTracks('source-A-before-other-choice',{site:'showing',other:'disabled'});
  await isolated(`document.querySelector('video').webkitEnterFullscreen()`);
  await selectNativeTracks('A-to-FluentRead-before-B',{site:'disabled',owned:'showing'});
  await selectNativeTracks('FluentRead-to-source-B',{owned:'disabled',other:'showing'});
  await isolated(`document.querySelector('video').webkitExitFullscreen()`);
  assert.equal(await page.evaluate(()=>window.__otherSiteTrack.mode),'showing','Leaving after another site selection must preserve that selection');
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'disabled');
  report.nativeSystemSelectionShim.otherSiteSelectionPreserved=true;
  await selectNativeTracks('restore-site-A-before-disable',{other:'disabled',site:'showing'});
  await configure({videoSubtitleVisible:false});await page.waitForFunction(()=>!document.querySelector('track[data-fluent-read-native-subtitles]'));
  assert.equal(await page.evaluate(()=>window.__siteTrack.mode),'showing');
  await configure({videoSubtitleVisible:true});await ready();
  await page.evaluate(()=>{const old=document.querySelector('video'); const next=old.cloneNode(false);old.replaceWith(next);next.load();});await ready();await capture('video-replaced');
  await page.reload({waitUntil:'domcontentloaded'});await activate();await installNativeShim();await ready();await capture('refresh-recovered');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await ready();
  await runDesktopMenu();
  await disableAndCheckCleanup();
}
main().catch(async error=>{
  report.errors.push(error.stack||String(error));process.exitCode=1;
  if(page&&!focusError){
    try{
      await checkFocus();
      report.failureDom=await page.evaluate(()=>{
        const video=document.querySelector('video');const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('video').forEach(node=>node.removeAttribute('src'));
        return {url:location.href,visibility:document.visibilityState,video:video&&{readyState:video.readyState,currentTime:video.currentTime,paused:video.paused,seeking:video.seeking,width:video.videoWidth,height:video.videoHeight,tracks:Array.from(video.textTracks).map(track=>({kind:track.kind,label:track.label,mode:track.mode,cues:track.cues?.length})),nodes:Array.from(video.querySelectorAll('track')).map(track=>({readyState:track.readyState,kind:track.kind,language:track.srclang,mode:track.track.mode,cues:track.track.cues?.length}))},html:clone.outerHTML};
      });
      fs.writeFileSync(path.join(artifacts,'failure-dom.html'),report.failureDom.html);delete report.failureDom.html;
      await page.screenshot({path:path.join(artifacts,'failure.png')});
      if(evaluateBusinessWorld)report.failureBusinessTracks=await evaluateBusinessWorld(`Array.from(document.querySelector('video')?.textTracks||[]).map(track=>({kind:track.kind,label:track.label,mode:track.mode,cues:track.cues?.length}))`);
      // Explicit diagnostic controls after the failure screenshot. These hidden
      // media nodes do not claim to satisfy the production caption assertion.
      if(control)report.failureConfig=await control.evaluate(async()=>{
        const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});const c=typeof read?.value==='string'?JSON.parse(read.value):(read?.value||{});
        return {on:c.on,from:c.from,to:c.to,videoTranslationEnabled:c.videoTranslationEnabled,videoSubtitleVisible:c.videoSubtitleVisible,videoSubtitleDisplayMode:c.videoSubtitleDisplayMode,videoService:c.videoService};
      });
    }catch(captureError){report.failureCaptureError=String(captureError);}
  }
}).finally(async()=>{
  if(worker)try{report.mockRequests=await worker.evaluate(()=>globalThis.__mobileVideoRequests||[]);}catch(error){report.workerCaptureError=String(error);}
  cleanupStarted=true;clearInterval(focusTimer);
  try{await closeOwned();}catch(error){report.errors.push(String(error));process.exitCode=1;}
  if(focusMonitor){
    try{await focusMonitor.stop();}catch(error){report.focusObserverCleanupError=String(error);process.exitCode=1;}
    const observerError=focusMonitor.error;
    if(observerError){report.focusObserverError=String(observerError);report.errors.push(report.focusObserverError);process.exitCode=1;}
    report.focusEvents=[...focusMonitor.events];
    if(browserPid&&report.focusEvents.some(event=>event.pid===browserPid)){
      report.errors.push('Owned test browser activated during complete focus observation, including cleanup');process.exitCode=1;
    }
  }
  if(profileDir&&(report.browserCloseReceipt==='shared-guard-fulfilled'||!launchAttempted)){
    fs.rmSync(profileDir,{recursive:true,force:true,maxRetries:5,retryDelay:200});report.profileRemoved=true;
  }else if(profileDir)report.retainedProfile=profileDir;
  save();
  console.log(JSON.stringify({ok:!process.exitCode,selectedSuite,artifacts,cases:report.cases.length,errors:report.errors},null,2));
});
