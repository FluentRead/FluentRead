#!/usr/bin/env node
// 划词朗读专项：生产扩展、真实媒体解码、稳定整词高亮及前后 5 秒跳转；只使用临时后台 Edge。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const {guardBrowserClose,getGuardedBrowserPid} = require('./testing/owned-browser-close.cjs');
const support = require('./run-selection-trigger-test.cjs');
const arg = key => process.argv[process.argv.indexOf(`--${key}`) + 1];
const output = path.resolve(arg('artifacts-dir'));
const extensionDir = path.resolve(arg('extension-dir'));
const {chromium} = createRequire(path.join(arg('playwright-root'), 'package.json'))('playwright');
const helperPath = path.resolve(arg('focus-safe-helper'));
const helper = require(helperPath);
const runtimeDiagnosticsPath = process.argv.includes('--runtime-diagnostics') ? path.resolve(arg('runtime-diagnostics')) : path.join(path.dirname(helperPath),'runtime-diagnostics.cjs');
const {createRuntimeDiagnostics,finalizeRun} = require(runtimeDiagnosticsPath);
const diagnostics = createRuntimeDiagnostics();
const baselineProbe = process.argv.includes('--baseline-layout-probe');
const layoutOnly = process.argv.includes('--layout-only');
const sentence = "For this release, we’re publishing the results in a GitHub repository, with protocols for paper revisions and citations.";
const translation = '对于这个版本，我们将在 GitHub 存储库中发布结果，其中包含论文修订和引用协议。';
const report = {ok:false,runScope:layoutOnly?'speech-layout-only':baselineProbe?'speech-layout-baseline-probe':'speech-follow-and-seek',providerEvidence:'Production extension with deterministic translation and a 20 second WAV response fixture. Actual offscreen media clock and decode; seek is verified only in the full speech suite. No live voice alignment or speaker claim.',cases:[],screenshots:[],consoleErrors:[],positions:[],layouts:[],focusSamples:[],ownedBrowserClosed:false,profileRemoved:false};
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const record = name => {report.cases.push(name);console.log('PASS',name);};
let session, context, page, popup, worker, browserPid;
function focusSample(label) {
 const actual=JSON.parse(execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',"ObjC.import('AppKit'); const a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(a.processIdentifier),name:ObjC.unwrap(a.localizedName)});"],{encoding:'utf8',timeout:5000}).trim());
 report.focusSamples.push({label,...actual});assert.notEqual(actual.pid,browserPid,`${label}: test browser took foreground focus`);
}
const cls = name => node => support.hasCdpClass(node,name);
async function until(check,message) {for(let i=0;i<100;i++){if(await check())return;await wait(100);}throw new Error(message);}
async function getNode(predicate) {const {root}=await support.getSelectionUiTree(page);return support.findCdpNode(root,predicate);}
async function click(predicate) {
 const {session:cdp,root}=await support.getSelectionUiTree(page);const node=support.findCdpNode(root,predicate);assert(node,'UI control missing');
 const {model}=await cdp.send('DOM.getBoxModel',{nodeId:node.nodeId});const q=model.content;
 await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);
}
async function inspect(fn) {
 const {session:cdp,root}=await support.getSelectionUiTree(page);const node=support.findCdpNode(root,cls('fr-translation-tooltip'));assert(node,'Selection card missing');
 const resolved=await cdp.send('DOM.resolveNode',{nodeId:node.nodeId});
 const result=await cdp.send('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:fn,returnByValue:true});
 await cdp.send('Runtime.releaseObject',{objectId:resolved.object.objectId});
 assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;
}
async function position() {
 const data=await inspect(`function(){const value=this.querySelector('.fr-playback-time')?.textContent||'';const current=this.querySelector('.fr-original-text .fr-speech-current');return {time:value,active:current?.textContent||'',currentCount:this.querySelectorAll('.fr-original-text .fr-speech-current').length}}`);
 if(!data.time)return null;const [minutes,seconds]=data.time.split(' / ')[0].split(':').map(Number);return {...data,seconds:minutes*60+seconds};
}
async function screenshot(name) {
 const box=await inspect('function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}');
 const file=path.join(output,name+'.png');focusSample(`${name}:before`);await page.screenshot({path:file,clip:box});report.screenshots.push(file);focusSample(`${name}:after`);
}

async function verifyBilingualLayout(name, labels) {
 const details=await inspect(`function(){
  const rect=node=>{const {left,right,top,bottom,width,height}=node.getBoundingClientRect();return {left,right,top,bottom,width,height};};
  const root=this.getRootNode(),toolbar=this.querySelector('.fr-study-toolbar');
  const source=this.querySelector('.fr-original-text'),translation=this.querySelector('.fr-translation-result');
  const blocks=[...(source?.parentElement?.querySelectorAll('.fr-text-block')||[])];
  const hits=[...this.querySelectorAll('.fr-study-toolbar button,.fr-tooltip-actions button')].map(button=>{
   const {left,right,top,bottom}=rect(button);
   const middle=root.elementFromPoint((left+right)/2,(top+bottom)/2);
   return {label:button.textContent.trim()||button.getAttribute('aria-label'),hit:middle?.closest('button')===button};
  });
  return {source:rect(source),translation:rect(translation),toolbar:rect(toolbar),overflow:toolbar.scrollWidth>toolbar.clientWidth+1,
   order:blocks.map(block=>block.querySelector('.fr-text-label').textContent.trim()),
   labelHeights:blocks.map(block=>rect(block.querySelector('.fr-text-label')).height),hits};
 }`);
 (report.bilingualLayouts ||= []).push({name,...details});
 if(!baselineProbe){
  assert.deepEqual(details.order,labels);
  assert(details.source.bottom<=details.translation.top+.5,JSON.stringify(details));
  assert(details.labelHeights.every(height=>height>1),JSON.stringify(details));
  assert(!details.overflow&&details.hits.every(item=>item.hit),JSON.stringify(details));
 }
 await screenshot(name);
}

async function verifyCompactToolbar() {
 const count=await inspect(`function(){
  const buttons=this.querySelectorAll('.fr-study-toolbar button');
  buttons[0].focus({preventScroll:true});
  return buttons.length;
 }`);
 for(let index=1;index<count;index++) await page.keyboard.press('Tab');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const details=await inspect(`function(){
  const root=this.getRootNode(),toolbar=this.querySelector('.fr-study-toolbar');
  const last=toolbar.querySelector('button:last-of-type'),bounds=last.getBoundingClientRect(),lane=toolbar.getBoundingClientRect();
  const content=this.querySelector('.fr-tooltip-content:not(.fr-reading-content)');
  return {focused:root.activeElement===last,visible:bounds.left>=lane.left-.5&&bounds.right<=lane.right+.5,
   scrollLeft:toolbar.scrollLeft,contentHeight:content.clientHeight};
 }`);
 assert(details.focused&&details.visible&&details.scrollLeft>0&&details.contentHeight>=55,JSON.stringify(details));
 report.compactToolbar=details;
 record('short card keeps the reading area and reveals the last action with Tab');
}

async function layout(name,{idle=false}={}) {
 const state=await inspect(`function(){
  const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
  const content=this.querySelector('.fr-tooltip-content:not(.fr-reading-content)'),status=this.querySelector('.fr-playing-status'),stop=status.querySelector('button:last-child'),style=getComputedStyle(status);
  return {short:this.classList.contains('fr-short-viewport'),cardScrollTop:this.scrollTop,cardScrollHeight:this.scrollHeight,cardClientHeight:this.clientHeight,card:rect(this),content:rect(content),status:rect(status),stop:stop?rect(stop):null,controls:[...status.querySelectorAll('button')].map(rect),label:status.querySelector('.fr-playing-label')?rect(status.querySelector('.fr-playing-label')):null,statusText:status.textContent.trim(),statusLineHeight:style.lineHeight,statusDisplay:style.display,scrollHeight:content.scrollHeight,clientHeight:content.clientHeight,scrollTop:content.scrollTop,viewport:{width:innerWidth,height:innerHeight},overflow:this.scrollWidth>this.clientWidth+1};
 }`);
 report.layouts.push({name,...state});
 if(baselineProbe)return state;
 if(idle){assert.equal(state.statusDisplay,'none',`${name}: idle speech bar occupies space`);return state;}
 assert(state.content.bottom<=state.status.top+.5,`${name}: speech bar overlaps content`);
 assert(state.stop&&state.stop.top>=state.status.top-.5&&state.stop.bottom<=state.status.bottom+.5,`${name}: stop control overflows speech bar`);
 for(const control of state.controls){assert(control.left>=state.status.left-.5&&control.right<=state.status.right+.5,`${name}: control overflows horizontally`);assert(control.top>=state.status.top-.5&&control.bottom<=state.status.bottom+.5,`${name}: control overflows vertically`);}
 if(!state.short)assert(state.status.bottom<=state.card.bottom+.5,`${name}: speech bar exceeds card`);assert(!state.overflow,`${name}: card overflows horizontally`);
 return state;
}
async function wheelContent(delta) {
 const point=await inspect(`function(){const r=this.querySelector('.fr-tooltip-content:not(.fr-reading-content)').getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2}}`);
 await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,delta);await wait(150);
}
async function scrollEnd(name) {
 await wheelContent(5000);await wheelContent(5000);
 const state=await layout(name);
 const end=await inspect(`function(){
  const blocks=[...this.querySelectorAll('.fr-translation-container > .fr-text-block')];
  return {texts:blocks.map(block=>block.querySelector('pre').textContent),bottom:blocks.at(-1).getBoundingClientRect().bottom};
 }`);
 report.layouts.at(-1).end=end;
 if(!baselineProbe){assert.deepEqual(end.texts,[sentence,translation]);assert(state.scrollTop+state.clientHeight>=state.scrollHeight-1,`${name}: text end not reachable`);assert(end.bottom<=state.content.bottom+.5,`${name}: text end is obscured`);}
 return state;
}
async function scrollTop() {await wheelContent(-5000);await wheelContent(-5000);}
async function resizeCard(width,height) {
 const point=await inspect(`function(){const handle=this.querySelector('[data-resize-edge="se"]'),r=handle.getBoundingClientRect(),card=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:card.width,height:card.height}}`);
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+width-point.width,point.y+height-point.height,{steps:12});await page.mouse.up();await wait(100);
}
async function startAudio(kind,name) {
 const before=await layout(`${name}:before`,{idle:true});
 await scrollTop();
 for(let attempt=0;attempt<8;attempt++){
  const placement=await inspect(`function(){const content=this.querySelector('.fr-tooltip-content:not(.fr-reading-content)').getBoundingClientRect(),button=this.querySelector('.fr-${kind==='source'?'original-text':'translation-result'} .fr-text-audio-btn').getBoundingClientRect();return {top:button.top,bottom:button.bottom,visible:button.top>=content.top&&button.bottom<=content.bottom,delta:(button.top+button.bottom-content.top-content.bottom)/2}}`);
  if(placement.visible)break;await wheelContent(placement.delta);
 }
 await click(node=>support.cdpAttribute(node,'aria-label')===`播放${kind==='source'?'原文':'译文'}`);
 await until(()=>getNode(node=>support.cdpAttribute(node,'aria-label')==='停止生成语音'),'Preparing state missing');
 const generating=await layout(`${name}:generating`);
 if(!baselineProbe&&name==='source-light'){assert(generating.content.height>=before.content.height-.5,'auto card shrinks readable text when speech starts');assert(Math.abs(generating.card.left-before.card.left)<.5&&Math.abs(generating.card.top-before.card.top)<.5,'speech start moves card anchor');assert(Math.abs(generating.card.width-before.card.width)<.5,'speech start changes card width');}
 await screenshot(`${name}-generating`);
 await until(async()=>{const state=await position();return state&&state.time.endsWith('/ 0:20');},'Actual audio clock missing');
 await layout(`${name}:playing`);
}

function wavFixture() {
 const rate=8000,count=rate*20,data=Buffer.alloc(44+count*2);
 data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(count*2,40);
 return data.toString('base64');
}
async function main() {
 fs.mkdirSync(output,{recursive:true});const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-selection-speech-'));let primaryError,launchAttempted=false;
 try {
  launchAttempted=true;
  session=await helper.launchFocusSafePersistentContext({chromium,profileDir,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check','--mute-audio'],viewport:{width:1440,height:960}});
  guardBrowserClose(session,profileDir);context=session.context;browserPid=await getGuardedBrowserPid(session);focusSample('after-launch');await diagnostics.start(context);Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement,extensionDir});
  assert.equal(session.windowPlacement?.browserFrontmost,false);assert.equal(session.windowPlacement?.mode,'background-visible-no-focus');
  const ready=await support.waitForWorker(context);worker=ready.worker;const id=ready.extensionId;diagnostics.setExtensionId(id);
  let initialPage=context.pages().find(candidate=>candidate.url().startsWith('about:blank#fluentread-background-'));
  const newPage=async()=>{const tab=initialPage||await helper.newPageWithoutForeground(context);initialPage=undefined;tab.on('pageerror',error=>report.consoleErrors.push(error.message));await diagnostics.attachPage(tab,'selection-speech');return tab;};
  popup=await newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
  const saved=await support.readStoredConfig(popup);
  await support.patchStoredConfig(popup,{on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',service:'microsoft',from:'auto',to:'zh-Hans',selectionTranslatorMode:'bilingual',selectionTranslatorPresentation:'card',selectionTranslatorTrigger:'icon',selectionTranslatorDelay:0,selectionTranslatorAutoDismiss:false,selectionTtsMode:'online-only',disableSelectionTranslator:false,useCache:false,hotkey:'none',floatingBallHotkey:'none',harness:{...saved.harness,enabled:true}});
  await worker.evaluate(({audioBase64,translation})=>{
   const native=fetch.bind(globalThis);globalThis.__speechFixtureCalls=0;
   globalThis.fetch=async(input,init)=>{
    const url=typeof input==='string'||input instanceof URL ? String(input) : input.url;
    globalThis.__speechFixtureUrls||=[];globalThis.__speechFixtureUrls.push(new URL(url).hostname);
    if(url.startsWith('https://edge.microsoft.com/translate/translatetext')){
     const texts=JSON.parse(init?.body ?? await input.clone().text());
     const translations=texts.map(source=>{
      // The production translator restores its protected GitHub term after the response.
      const protectedName=source.match(/__FRTERM_[a-z0-9]+_\d+__/iu)?.[0];
      return {translations:[{text:protectedName ? translation.replace('GitHub',protectedName) : translation,to:'zh-Hans'}]};
     });
     return new Response(JSON.stringify(translations),{headers:{'content-type':'application/json'}});
    }
    if(url.startsWith('https://dev.microsofttranslator.com/apps/endpoint'))return new Response(JSON.stringify({t:'speech-fixture',r:'fixture'}),{headers:{'content-type':'application/json'}});
    if(url.includes('.tts.speech.microsoft.com/cognitiveservices/v1')){
     globalThis.__speechFixtureCalls++;await new Promise(resolve=>setTimeout(resolve,1800));const bytes=Uint8Array.from(atob(audioBase64),char=>char.charCodeAt(0));return new Response(bytes,{headers:{'content-type':'audio/wav'}});
    }
    return native(input,init);
   };
  },{audioBase64:wavFixture(),translation});
  await context.route('https://example.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="en"><meta charset="utf-8"><title>Speech follow fixture</title><style>body{margin:60px;color:#253248;font:20px/1.8 system-ui}p{max-width:760px}@media(max-width:500px){body{margin:24px;font-size:16px}}</style><p id="sentence">${sentence}</p></html>`}));
  page=await newPage();await page.goto('https://example.com/speech');await page.locator('#fluent-read-selection-translator-container').waitFor({state:'attached'});await helper.activateExtensionTabWithoutForeground(context,page);
  const points=await page.evaluate(()=>{const text=document.querySelector('#sentence').firstChild,range=document.createRange();range.setStart(text,0);range.setEnd(text,1);const start=range.getBoundingClientRect();range.setStart(text,text.length-1);range.setEnd(text,text.length);const end=range.getBoundingClientRect();return {sx:start.left,sy:start.top+start.height/2,ex:end.right+2,ey:end.top+end.height/2};});
  await page.mouse.move(points.sx,points.sy);await page.mouse.down();await page.mouse.move(points.ex,points.ey,{steps:14});await page.mouse.up();
  await until(()=>getNode(cls('fr-selection-indicator')),'Selection entry missing');await click(cls('fr-selection-indicator'));
  await until(async()=>await getNode(cls('fr-translation-result')) && await inspect(`function(){return this.querySelector('.fr-translation-result pre').textContent}`)===translation,'Translation missing');
  const cardUi=await inspect(`function(){const navigation=this.querySelector('.fr-study-navigation');return {tabs:navigation?.querySelectorAll('.fr-study-toolbar button').length,close:!!navigation?.querySelector('.fr-close-btn'),share:!!navigation?.querySelector('.fr-share-card-entry'),header:!!this.querySelector('.fr-tooltip-header'),language:!!this.querySelector('[data-target-language]'),brand:!!this.querySelector('.fr-tooltip-brand-icon')}}`);
  assert(cardUi.tabs===6&&cardUi.close&&cardUi.share);
  assert(!cardUi.header&&!cardUi.language&&cardUi.brand);
  record('translation card starts with action tabs and keeps share and close without a language header');
  await layout('idle',{idle:true});
  await verifyBilingualLayout('bilingual-light',['原文','译文']);
  const original=await inspect(`function(){this.__speechWordNodes=Array.from(this.querySelectorAll('.fr-original-text .fr-speech-word'));this.__speechWordRects=this.__speechWordNodes.map(node=>{const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});return this.querySelector('.fr-original-text pre').textContent}`);assert.equal(original,sentence);
  await startAudio('source','source-light');
  await scrollEnd('source-light:end');await screenshot('source-light-end');
  if(baselineProbe){report.ok=true;return;}
  if(layoutOnly){
   await support.patchStoredConfig(popup,{theme:'dark'});await wait(250);await layout('source-dark');await screenshot('speech-dark');
   await resizeCard(320,300);await scrollTop();
   await verifyBilingualLayout('bilingual-dark-320',['原文','译文']);
   await resizeCard(280,140);await verifyCompactToolbar();await scrollEnd('manual-minimum:end');await screenshot('speech-manual-minimum');
   await resizeCard(320,180);await scrollEnd('manual-small:end');await screenshot('speech-manual-small');
   await page.setViewportSize({width:390,height:800});await wait(250);await layout('source-narrow');await screenshot('speech-narrow');
   await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');await layout('stopped',{idle:true});
   await startAudio('translation','translation-narrow');await scrollEnd('translation-playing:end');await screenshot('speech-translation-narrow');
   await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');await layout('translation-stopped',{idle:true});
   await startAudio('source','source-restarted');await scrollEnd('source-restarted:end');
   await page.setViewportSize({width:390,height:110});await wait(250);
   const short=await layout('source-short-viewport');assert(short.short,'short viewport did not use whole-card scroll');
   await page.mouse.move(short.card.left+20,short.card.top+short.card.height/2);await page.mouse.wheel(0,5000);await wait(200);await page.mouse.wheel(0,5000);await wait(200);
   const shortEnd=await layout('source-short-viewport:end');assert(shortEnd.status.bottom<=shortEnd.card.bottom+.5&&shortEnd.status.top>=shortEnd.card.top-.5,'whole-card scroll does not reveal speech bar');
   await screenshot('speech-short-viewport');
   await page.setViewportSize({width:390,height:800});await wait(250);
   await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');await layout('source-restarted-stopped',{idle:true});
   await support.patchStoredConfig(popup,{uiLanguage:'en-US'});
   await until(async()=>await inspect("function(){return this.querySelector('.fr-study-toolbar button').textContent.trim()}")==='Translation','English card is not localized');
   await resizeCard(280,280);await scrollTop();
   await verifyBilingualLayout('bilingual-english-280',['Original','Translation']);
   await resizeCard(280,140);
   await inspect("function(){this.querySelector('.fr-study-toolbar button:last-of-type').focus({preventScroll:true})}");
   await page.keyboard.press('Enter');
   await until(()=>inspect("function(){return this.querySelector('.fr-study-toolbar button:last-of-type').getAttribute('aria-pressed')==='true'}"),'Enter does not activate the last action in the compact toolbar');
   record('original precedes translation and the wrapped toolbar keeps labels and actions reachable in light and dark cards');
   assert.deepEqual(report.consoleErrors,[]);await diagnostics.flush();diagnostics.assertClean();
   record('generation, playback, stop/restart, source/translation, manual small size and narrow dark card keep text and speech controls separate');report.ok=true;return;
  }
  const before=await position();await click(node=>support.cdpAttribute(node,'aria-label')==='前进 5 秒');
  await until(async()=>{const state=await position();return state&&state.seconds>=before.seconds+5;},'Forward did not seek 5 seconds');
  const forward=await position();assert(forward.seconds<=before.seconds+6);report.positions.push({before,forward});
  await screenshot('speech-follow-light');
  await click(node=>support.cdpAttribute(node,'aria-label')==='后退 5 秒');await until(async()=>{const state=await position();return state&&state.seconds<=forward.seconds-4;},'Rewind did not seek 5 seconds');
  const rewind=await position();report.positions.push({rewind});assert.equal(await worker.evaluate(()=>globalThis.__speechFixtureCalls),1);record('actual decoded media seeks forward/backward 5 seconds without synthesizing again');
  const stable=await inspect(`function(){const nodes=Array.from(this.querySelectorAll('.fr-original-text .fr-speech-word'));return {sameNodes:nodes.every((node,i)=>node===this.__speechWordNodes[i]),sameLayout:nodes.every((node,i)=>{const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height].every((value,j)=>Math.abs(value-this.__speechWordRects[i][j])<.1)}),text:this.querySelector('.fr-original-text pre').textContent,currentCount:this.querySelectorAll('.fr-original-text .fr-speech-current').length}}`);
  assert(stable.sameNodes);assert(stable.sameLayout);assert.equal(stable.text,sentence);assert.equal(stable.currentCount,1);record('current word stays whole and word nodes, original text and line layout remain stable');
  await support.patchStoredConfig(popup,{theme:'dark'});await wait(350);await layout('source-dark');await screenshot('speech-follow-dark');
  const style=await inspect(`function(){const current=this.querySelector('.fr-speech-current');const s=getComputedStyle(current);return {display:s.display,border:s.borderBottomWidth,color:s.backgroundColor,transition:s.transitionProperty}}`);assert.equal(style.display,'inline');assert.equal(style.border,'0px');assert.equal(style.transition,'background-color');assert.notEqual(style.color,'rgba(0, 0, 0, 0)');record('neutral full word background supports dark theme without width sweep or underline');
  await resizeCard(320,180);await scrollEnd('manual-small:end');await screenshot('speech-manual-small');record('manually reduced card keeps speech controls separate and full text reachable');
  await page.setViewportSize({width:390,height:800});await wait(250);await layout('source-narrow');await screenshot('speech-follow-390');
  const narrowControls=await inspect(`function(){const card=this.getBoundingClientRect(),buttons=Array.from(this.querySelectorAll('.fr-playback-controls button')).map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});return {card:{left:card.left,right:card.right},buttons,viewport:innerWidth}}`);assert(narrowControls.card.left>=0&&narrowControls.card.right<=narrowControls.viewport+1);assert(narrowControls.buttons.every(button=>button.left>=narrowControls.card.left&&button.right<=narrowControls.card.right));for(let i=1;i<narrowControls.buttons.length;i++)assert(narrowControls.buttons[i].left>=narrowControls.buttons[i-1].right);report.narrowLayout=narrowControls;record('5 second controls fit the 390px card without overlap');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await inspect(`function(){return getComputedStyle(this.querySelector('.fr-speech-word')).transitionDuration}`),'0s');record('reduced motion disables highlight animation');
  await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');await until(async()=>!(await getNode(cls('fr-speech-current'))),'Stop left highlight');
  await layout('stopped',{idle:true});
  assert.equal(await getNode(cls('fr-playback-time')),null);await wait(400);assert.equal(await getNode(cls('fr-speech-current')),null);record('stop clears highlight and clock and prevents delayed progress from returning');
  await startAudio('translation','translation-narrow');await scrollEnd('translation-playing:end');await screenshot('speech-translation-narrow');
  await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');await layout('translation-stopped',{idle:true});
  await startAudio('source','source-restarted');await layout('source-restarted');
  await click(node=>support.cdpAttribute(node,'aria-label')==='停止播放');record('translation and original can restart after stop without covering text');
  await scrollTop();await support.patchStoredConfig(popup,{uiLanguage:'en-US'});await wait(350);
  await click(node=>support.hasCdpClass(node,'fr-text-audio-btn') && /^Play /.test(support.cdpAttribute(node,'aria-label')||''));
  await until(()=>getNode(node=>support.cdpAttribute(node,'aria-label')==='Forward 5 seconds'),'English seek label missing');
  assert(await getNode(node=>support.cdpAttribute(node,'aria-label')==='Rewind 5 seconds'));record('English seek controls use localized accessible names');
  for(let i=0;i<4;i++){if(!await getNode(node=>support.cdpAttribute(node,'aria-label')==='Forward 5 seconds'))break;await click(node=>support.cdpAttribute(node,'aria-label')==='Forward 5 seconds');await wait(200);}
  await until(async()=>!(await getNode(cls('fr-playback-time'))),'Seeking to the end did not finish playback');
  assert.equal(await getNode(cls('fr-speech-current')),null);record('repeated 5 second seeks clamp to the real end and clear playback');
  await layout('ended',{idle:true});
  assert.deepEqual(report.consoleErrors,[]);await diagnostics.flush();diagnostics.assertClean();report.ok=true;
 } catch(error) {
  report.error=error.stack||String(error);
  if(page){report.failureUi=support.cdpText((await support.getSelectionUiTree(page)).root);await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
  if(worker)report.fixtureFetch=await worker.evaluate(()=>({hosts:globalThis.__speechFixtureUrls,calls:globalThis.__speechFixtureCalls})).catch(()=>null);
  primaryError=error;
 }
 finally {
  await finalizeRun({diagnostics,result:report,artifactsDir:output,primaryError,cleanup:[
   {stage:'owned-browser-close',action:async()=>{if(session){await session.close();report.ownedBrowserClosed=true;}}},
   {stage:'owned-profile-removal',action:async()=>{if(report.ownedBrowserClosed||!launchAttempted){fs.rmSync(profileDir,{recursive:true,force:true});report.profileRemoved=true;}else report.retainedProfile=profileDir;}},
  ],emitReport:()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))});
 }
 if(primaryError)throw primaryError;
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
