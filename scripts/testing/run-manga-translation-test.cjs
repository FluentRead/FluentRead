'use strict';
/**
 * @file scripts/testing/run-manga-translation-test.cjs
 * 文件职责：在临时 profile 中用可信点击和真实模型验证生产漫画翻译、滚动及缓存行为。
 * 主要内容：固定模型文件经校验后由既有 UI 导入；性能模式测量冷/热推理，质量 manifest 检查真实 OCR 锚点、画面保护与原/译切换。
 * 模块边界：仅替换夹具的文字服务传输；不修改生产 OCR/修补结果，不访问日常浏览器 profile，浏览器启动与页面创建均走不抢焦点 helper。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {ensureImageTranslationModelFiles, defaultImageTranslationModelCacheDirectory, readImageTranslationModelManifest} = require('./image-model-cache.cjs');
const {validateQualityFixtureExpectations,evaluateQualityReadingOrder,evaluateQualityFixture} = require('./manga-quality-corpus.cjs');
function arg(name, fallback) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];}
let extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
let diagnosticFixture;
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-manga-browser'));
const packages = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
const helper = arg('focus-safe-helper', process.env.FLUENTREAD_FOCUS_SAFE_HELPER);
if (!packages || !helper) throw new Error('Provide --playwright-root and --focus-safe-helper');
const {chromium} = require(path.join(packages, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helper);
const liveSite = process.argv.includes('--live-site');
const liveTranslation = process.argv.includes('--live-translation');
const readerSmoke = process.argv.includes('--reader-smoke');
const canvasReaderTest = process.argv.includes('--canvas-reader');
const backgroundReaderTest = process.argv.includes('--background-reader');
const segmentReaderTest = process.argv.includes('--segment-reader');
const segmentStart=Number(arg('segment-start','0'));
assert.ok([canvasReaderTest,backgroundReaderTest,segmentReaderTest].filter(Boolean).length<=1,'Choose one public surface type');
if(segmentReaderTest)assert.ok(liveSite&&readerSmoke&&Number.isInteger(segmentStart)&&segmentStart>=0&&segmentStart<=40,'Segments require a live reader smoke with a bounded start index');
const surfaceReaderTest = canvasReaderTest || backgroundReaderTest;
const qualityPages = Number(arg('quality-pages','2'));
assert.ok(Number.isInteger(qualityPages)&&qualityPages>=1&&qualityPages<=10,'Public image quality samples must contain 1–10 pages');
const blockedOfficial = process.argv.includes('--blocked-official');
const blockedAll = process.argv.includes('--blocked-all-model-sources');
const offlineModels = arg('offline-models-dir',null);
const preloadModels = arg('preload-models-dir',null);
const modelCacheDir = path.resolve(arg('model-cache-dir',defaultImageTranslationModelCacheDirectory()));
const baseline = process.argv.includes('--baseline');
// 仅约束缓存助手的下载，不能替代浏览器全 target 网络隔离。
const noCacheDownload = process.argv.includes('--model-cache-no-download');
if(noCacheDownload)assert.ok(!preloadModels&&!offlineModels&&!blockedOfficial&&!blockedAll&&!baseline,
    '--model-cache-no-download requires the shared model cache; it does not apply to other model-source modes');
const readingPauseMs=Number(arg('reading-pause-ms','0'));
const skipFirstCancel=process.argv.includes('--skip-first-cancel');
const readAheadTest=process.argv.includes('--prefetch-pages');
const scrollStabilityTest=process.argv.includes('--scroll-stability');
const scrollIntentTest=process.argv.includes('--scroll-intent');
const cacheNavigationTest=process.argv.includes('--cache-navigation');
const tieredCacheTest=process.argv.includes('--tiered-cache');
const pageFeedbackTest=process.argv.includes('--page-feedback');
const errorRecoveryTest=process.argv.includes('--error-recovery');
const errorRecoverySurface=arg('error-recovery-surface','image');
const recoveryCanvasAlpha=process.argv.includes('--recovery-canvas-alpha');
const recoveryBackgroundAlpha=process.argv.includes('--recovery-background-alpha');
if(recoveryCanvasAlpha)assert.ok(errorRecoveryTest&&errorRecoverySurface==='canvas','Transparent Canvas checks require the controlled Canvas recovery fixture');
if(recoveryBackgroundAlpha)assert.ok(errorRecoveryTest&&errorRecoverySurface==='background','Transparent background checks require the controlled background recovery fixture');
assert.ok(['image','canvas','background','segments'].includes(errorRecoverySurface),'Recovery surface must be image, canvas, background or segments');
if(process.argv.includes('--error-recovery-surface'))assert.ok(errorRecoveryTest,'--error-recovery-surface requires --error-recovery');
const recoveryViewportValue=arg('recovery-viewport',null),recoveryViewportParts=recoveryViewportValue?.match(/^(\d{3,4})x(\d{3,4})$/);
const recoveryViewport=recoveryViewportParts?{width:Number(recoveryViewportParts[1]),height:Number(recoveryViewportParts[2])}:null;
const recoveryLongDetails=process.argv.includes('--recovery-long-details'),recoveryRtl=process.argv.includes('--recovery-rtl');
if(process.argv.includes('--recovery-viewport'))assert.ok(errorRecoveryTest&&recoveryViewport&&recoveryViewport.width>=320&&recoveryViewport.width<=1600&&recoveryViewport.height>=240&&recoveryViewport.height<=1200,'Recovery CSS viewport must be 320–1600 x 240–1200 and requires --error-recovery');
if(recoveryLongDetails||recoveryRtl)assert.ok(errorRecoveryTest,'Recovery long-details and RTL flags require --error-recovery');
const prefetchPages=Number(arg('prefetch-pages','0'));
const explicitPipelineInputs=arg('pipeline-inputs',null)?.split(',').map(file=>path.resolve(file));
const qualityManifestPath=arg('quality-manifest',null);
const qualityProfile=arg('quality-profile','manga');
assert.ok(['manga','image'].includes(qualityProfile),'Quality profile must be manga or image');
const ordinaryImageQuality=qualityProfile==='image';
assert.ok(!qualityManifestPath||!explicitPipelineInputs,'Choose either --quality-manifest or --pipeline-inputs');
const qualityManifest=qualityManifestPath?JSON.parse(fs.readFileSync(path.resolve(qualityManifestPath),'utf8')):null;
const qualityFixtures=qualityManifest?.fixtures;
if(qualityManifest){
    assert.equal(qualityManifest.version,1,'Use a supported quality manifest version');
    assert.ok(Array.isArray(qualityFixtures)&&qualityFixtures.length>=1&&qualityFixtures.length<=32,'Quality corpus contains 1–32 bounded scenes');
    const names=new Set();
    for(const fixture of qualityFixtures){
        assert.ok(typeof fixture.name==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(fixture.name)&&!names.has(fixture.name),'Quality scene names are unique safe artifact stems');names.add(fixture.name);
        assert.ok(typeof fixture.file==='string'&&fixture.mime==='image/png','Quality corpus uses named PNG files');
        fixture.input=path.resolve(path.dirname(path.resolve(qualityManifestPath)),fixture.file);
        const bytes=fs.readFileSync(fixture.input);
        assert.equal(bytes.length,fixture.bytes,`Fixture byte length: ${fixture.name}`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.sha256,`Fixture SHA-256: ${fixture.name}`);
        assert.ok(['en','ja','ko','ru','auto'].includes(fixture.sourceLanguage),'Quality scenes specify a supported OCR language');
        assert.ok([fixture.width,fixture.height].every(value=>Number.isInteger(value)&&value>0&&value<=8192)&&fixture.width*fixture.height<=16_777_216,'Quality scene dimensions match the runtime 8192-side / 16MP limits');
        validateQualityFixtureExpectations(fixture);
        assert.ok(Array.isArray(fixture.protectedProbes)&&fixture.protectedProbes.length&&fixture.protectedProbes.every(probe=>Number.isInteger(probe.x)&&probe.x>=0&&probe.x<fixture.width&&Number.isInteger(probe.y)&&probe.y>=0&&probe.y<fixture.height&&Array.isArray(probe.rgb)&&probe.rgb.length===3&&probe.rgb.every(value=>Number.isInteger(value)&&value>=0&&value<=255)),'Quality scenes declare protected source pixels');
    }
}
const pipelineInputs=qualityFixtures?.map(fixture=>fixture.input)||explicitPipelineInputs;
if(qualityManifest)assert.ok(fs.existsSync(path.join(extensionDir,'manifest.json')),'Quality matrix requires an existing built extension manifest before browser launch');
if(ordinaryImageQuality)assert.ok(qualityManifest&&!liveSite&&!liveTranslation&&!readerSmoke&&!surfaceReaderTest&&!segmentReaderTest
    &&!baseline&&!errorRecoveryTest&&!readAheadTest&&!scrollStabilityTest&&!scrollIntentTest&&!cacheNavigationTest&&!tieredCacheTest&&!pageFeedbackTest&&prefetchPages===0
    &&!offlineModels&&!preloadModels&&!blockedOfficial&&!blockedAll
    &&qualityFixtures.every(fixture=>!fixture.expectedNoText&&['en','ja','auto'].includes(fixture.sourceLanguage)),
    'Ordinary Paddle quality requires a controlled nonempty en/ja/auto corpus and shared OCR cache, without other reader modes, prefetch or legacy model-source diagnostics');
if(errorRecoveryTest)assert.ok(!liveSite&&!liveTranslation&&!readerSmoke&&!canvasReaderTest&&!backgroundReaderTest&&!segmentReaderTest&&!pipelineInputs
    &&!readAheadTest&&!scrollStabilityTest&&!scrollIntentTest&&!cacheNavigationTest&&!tieredCacheTest&&!pageFeedbackTest&&prefetchPages===0,
    'Error recovery uses only its controlled fixture with prefetch disabled, without live/pipeline/other reader modes');
const pipelineRounds=Number(arg('pipeline-rounds',qualityManifest?'1':'3'));
if(pipelineInputs)assert.ok(Number.isInteger(pipelineRounds)&&pipelineRounds>=(qualityManifest?1:2)&&pipelineRounds<=5,qualityManifest?'Quality scenes allow 1–5 bounded rounds':'Measure first use separately from bounded warm runs (2–5 rounds)');
const layoutTraceLimit=Math.max(100,(qualityFixtures?.length??0)*pipelineRounds+8);
const graphOverride=arg('pipeline-graph',null);
const gpuDiagnosis=process.argv.includes('--gpu-diagnosis');
const forceCpu=process.argv.includes('--pipeline-cpu');
const extensionDebugging=process.argv.includes('--extension-debugging');
const startupExtensionId=arg('extension-id',null);
if(startupExtensionId)assert.match(startupExtensionId,/^[a-p]{32}$/,'Use a verified unpacked extension ID');
const traceReader=process.argv.includes('--trace-reader');
const traceLayout=process.argv.includes('--trace-layout')||Boolean(qualityManifest);
const recoveryFixtureUrl=errorRecoverySurface==='canvas'?'https://comic-walker.com/detail/KC_1068_S/episodes/KC_1068_E':
    errorRecoverySurface==='background'?'https://palcy.jp/comics/1068':'https://mangaplus.shueisha.co.jp/viewer/1024050';
const targetUrl = arg('site-url',errorRecoveryTest?recoveryFixtureUrl:'https://mangaplus.shueisha.co.jp/viewer/1024050');
if(errorRecoveryTest&&errorRecoverySurface!=='image')assert.equal(targetUrl,recoveryFixtureUrl,'Controlled recovery surfaces use an existing production reader profile and its exact fixture URL');
const pixiv=targetUrl.includes('pixiv.net/artworks/');
const explicitReaderSelector=arg('reader-selector',null);
if(explicitReaderSelector)assert.ok(readerSmoke && liveSite && !pixiv && !surfaceReaderTest,'Explicit image selectors are limited to live reader smoke checks');
if(qualityPages===1)assert.ok(explicitReaderSelector&&readerSmoke&&liveSite&&!segmentReaderTest,'A single body page requires an explicit public image reader smoke');
const readerStartIndex=Number(arg('reader-start-index','0'));
assert.ok(Number.isInteger(readerStartIndex)&&readerStartIndex>=0&&readerStartIndex<=40,'Reader start index must be a bounded body image index');
if(readerStartIndex)assert.ok(explicitReaderSelector&&liveSite&&readerSmoke&&!segmentReaderTest,'A start index requires an explicit public image reader smoke');
const readerNextSelector=arg('reader-next-selector',null);
if(readerNextSelector)assert.ok(explicitReaderSelector&&liveSite&&readerSmoke&&!segmentReaderTest,'Page-turn controls require an explicit public image reader smoke');
let readerCurrentIndex=0;
const explicitCanvasSelector=arg('canvas-selector',null);
const canvasOpenSelector=arg('canvas-open-selector',explicitCanvasSelector?null:'a.-cv-inst-btn.x-cv-inst-ok');
const canvasInitialTurns=Number(arg('canvas-initial-turns',explicitCanvasSelector?'0':'2'));
const canvasTurnKey=arg('canvas-turn-key','ArrowLeft');
const canvasTurnCount=Number(arg('canvas-turn-count','2'));
const canvasNextClickSelector=arg('canvas-next-click-selector',null);
const canvasNextClickPosition=arg('canvas-next-click-position',null)?.split(',').map(Number);
if(canvasNextClickSelector)assert.ok(surfaceReaderTest&&liveSite&&explicitCanvasSelector&&canvasNextClickPosition?.length===2&&canvasNextClickPosition.every(value=>Number.isInteger(value)&&value>=0&&value<=4096),'Public canvas click turns require an explicit surface and bounded x,y coordinates');
else assert.equal(canvasNextClickPosition,undefined,'Click coordinates require a public canvas selector');
const canvasReadySettleMs=Number(arg('canvas-ready-settle-ms','0'));
assert.ok(Number.isInteger(canvasReadySettleMs)&&canvasReadySettleMs>=0&&canvasReadySettleMs<=30000,'Canvas settling time must be 0–30000ms');
if(canvasReadySettleMs)assert.ok(surfaceReaderTest&&liveSite,'Canvas settling is limited to public live surface checks');
if(explicitCanvasSelector)assert.ok(surfaceReaderTest && liveSite,'Explicit canvas selectors are limited to live public canvas chapters');
if(surfaceReaderTest){
    assert.ok(Number.isInteger(canvasInitialTurns)&&canvasInitialTurns>=0&&canvasInitialTurns<=4,'Initial canvas turns must be 0–4');
    assert.ok(Number.isInteger(canvasTurnCount)&&canvasTurnCount>=1&&canvasTurnCount<=4,'Canvas turns must be 1–4');
    assert.ok(['ArrowLeft','ArrowRight'].includes(canvasTurnKey),'Canvas chapter turns use a normal horizontal arrow key');
}
const recoverySelector=errorRecoverySurface==='canvas'?'[data-viewer-full-screen-helper] canvas[data-type="contents"]':
    errorRecoverySurface==='background'?'div[id^="page-"][style*="blob:"]':'.zao-image';
const readerSelector=(errorRecoveryTest&&errorRecoverySurface!=='image'?recoverySelector:null)||explicitReaderSelector || (surfaceReaderTest?explicitCanvasSelector || (backgroundReaderTest?'div[id^="page-"][style*="blob:"]':'#comici-viewer .-cv-page-canvas canvas'):pixiv?'img[src*="/img-master/"][src*="/150354216_p"], img[src*="/img-original/"][src*="/150354216_p"]':'.zao-image');
const sourceLanguage=arg('source-language',pixiv||surfaceReaderTest?'ja':'en');
assert.ok(['en','ja','ko','ru','auto'].includes(sourceLanguage),'Use a supported sample source language');
const targetLanguage=arg('target-language','zh-Hans');
assert.ok(['zh-Hans','en'].includes(targetLanguage),'Use a bounded sample target language');
const canvasContentPixels=process.argv.includes('--canvas-content-pixels');
if(canvasContentPixels)assert.ok(canvasReaderTest&&liveSite&&explicitCanvasSelector,'Content-world pixel diagnostics require an explicit live public canvas reader');
const canvasFirstSpreadOnly=process.argv.includes('--canvas-first-spread-only');
const canvasLoadingSelector=arg('canvas-loading-selector',null);
if(canvasFirstSpreadOnly)assert.ok(canvasReaderTest&&liveSite&&explicitCanvasSelector,'First-spread scope requires an explicit public canvas reader');
if(canvasLoadingSelector)assert.ok(canvasFirstSpreadOnly&&canvasContentPixels,'Native loading checks require bounded first-spread content-world scope');
const readerOpenSelector=arg('reader-open-selector',null);
if(readerOpenSelector)assert.ok(readerSmoke&&liveSite&&!surfaceReaderTest,'Image reader opening requires an explicit live smoke check');
const readerScrollSelector=arg('reader-scroll-selector',null);
if(readerScrollSelector)assert.ok(explicitReaderSelector&&liveSite&&readerSmoke&&!segmentReaderTest,'Lazy image scroll anchors require an explicit public image smoke check');
const imageTurnKey=arg('image-turn-key',null),imageInitialTurns=Number(arg('image-initial-turns','0'));
if(imageTurnKey)assert.ok(explicitReaderSelector&&liveSite&&readerSmoke&&!segmentReaderTest
    &&['ArrowLeft','ArrowRight'].includes(imageTurnKey)&&Number.isInteger(imageInitialTurns)&&imageInitialTurns>=0&&imageInitialTurns<=4,
    'Paged images require an explicit live image smoke, a horizontal arrow and 0–4 initial turns');
const imageVisibleSource=process.argv.includes('--image-visible-source');
if(imageVisibleSource)assert.ok(imageTurnKey,'Visible image selection requires explicit paged image scope');
const imageStableUrl=process.argv.includes('--image-stable-url');
if(imageStableUrl)assert.ok(imageTurnKey,'Stable page URLs require explicit paged image scope');
const readerDismissSelector=arg('reader-dismiss-selector',null);
if(readerDismissSelector)assert.ok(imageTurnKey,'Public reader notices are limited to explicit paged image scope');
let profile; let launchAttempted = false;
fs.mkdirSync(artifacts, {recursive: true});
const report = {site: liveSite ? 'live MANGA Plus' : 'controlled MANGA Plus reader fixture',
    translation: liveTranslation ? 'live Google' : 'deterministic Google text transport',
    ocr: ordinaryImageQuality ? 'real production PaddleOCR ordinary-image profile' : ['ru','ko'].includes(sourceLanguage) ? 'real production Tesseract with manga cleanup and typesetting' : 'real production PaddleOCR', qualityProfile, cases: [], screenshots: [], errors: [], hostErrors: [], pageErrors: [], consoleErrors: []};
if(errorRecoveryTest){
    report.site=`controlled ${errorRecoverySurface} recovery fixture using production reader discovery`;
    report.errorRecovery={surface:errorRecoverySurface,fixtureUrl:targetUrl,sourceSelector:readerSelector,
        scope:'Controlled page matches production reader discovery; only OCR-following text transport is failed; source pixels remain unchanged, only the exact native Canvas visibility or background-image presentation receipt is permitted while translated output is visible, and all attributes are checked after restoration',canvasAlpha:recoveryCanvasAlpha,backgroundAlpha:recoveryBackgroundAlpha};
}
if(pixiv)report.site='live Pixiv artwork 150354216';
if(surfaceReaderTest){report.site=`live readable ${backgroundReaderTest?'background':'canvas'} chapter: ${targetUrl}`;report.canvasReader={selector:readerSelector,openSelector:canvasOpenSelector,initialTurns:canvasInitialTurns,turnKey:canvasTurnKey,turnCount:canvasTurnCount,readySettleMs:canvasReadySettleMs,nextClickSelector:canvasNextClickSelector,nextClickPosition:canvasNextClickPosition};}
if(explicitReaderSelector){report.site=`live image chapter: ${targetUrl}`;report.readerSelector=explicitReaderSelector;}
report.prefetchPages=prefetchPages;
report.sourceLanguage=sourceLanguage;report.readerOpenSelector=readerOpenSelector;report.readerScrollSelector=readerScrollSelector;
report.targetLanguage=targetLanguage;
if(qualityManifest)report.qualityManifest={path:path.resolve(qualityManifestPath),version:qualityManifest.version,scenes:qualityFixtures.map(({name,sourceLanguage,scene,expectedAnchors,expectedNoText,forbiddenRegions,protectedProbes})=>({name,sourceLanguage,scene,expectedAnchors,expectedNoText,forbiddenRegions,protectedProbes}))};
if(canvasContentPixels)report.canvasPixelWorld='own production extension content world; ordinary API, no prototype substitution';
report.readerStartIndex=readerStartIndex;
report.readerNextSelector=readerNextSelector;
if(imageTurnKey)report.pagedImages={turnKey:imageTurnKey,initialTurns:imageInitialTurns,urlPolicy:imageStableUrl?'stable':'changes'};
let launched, page, worker, cdp, popup, modelObserver, browserPid,loadedExtensionId,contentPixelContext,preparedModels;
loadedExtensionId=startupExtensionId;
function focusGuard() {
    const current=JSON.parse(execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',"ObjC.import('AppKit');const app=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(app.processIdentifier),name:ObjC.unwrap(app.localizedName)});"],{encoding:'utf8'}));
    assert.notEqual(current.pid,browserPid,'Isolated test browser must stay behind the user app');
    report.focusChecks??=[];report.focusChecks.push(current);
}
// Offscreen 文档不在 Playwright 的 page/request 集合里，必须观察自己的隔离浏览器 CDP target。
async function observeModelDownloads(extensionId) {
    const [port,endpoint]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');
    const socket=new WebSocket(`ws://127.0.0.1:${Number(port)}${endpoint}`),pending=new Map();let sequence=0;
    const nativeClose = socket.close.bind(socket);
    let terminalError, closeRequested = false, rejectOpen, openTimer;
    const fail = error => {
        terminalError ??= error;
        clearTimeout(openTimer);
        rejectOpen?.(terminalError);
        for (const callback of pending.values()) callback.reject(terminalError);
        pending.clear();
        if (!closeRequested) {closeRequested = true; nativeClose();}
    };
    socket.close = () => fail(new Error('CDP socket closed by its owner'));
    socket.addEventListener('error', () => fail(new Error('CDP socket error')));
    socket.addEventListener('close', () => fail(new Error('CDP socket closed')));
    function command(method,params={},sessionId) {
        if (terminalError) return Promise.reject(terminalError);
        const id=++sequence;
        return new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);
            pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
            try {socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
            catch (error) {fail(error);}
        });
    }
    socket.addEventListener('message',event=>{
        if (terminalError) return;
        try {
            const message=JSON.parse(String(event.data));
            if(message.id){const callback=pending.get(message.id);if(callback){pending.delete(message.id);message.error?callback.reject(new Error(message.error.message)):callback.resolve(message.result);}}
            if(message.method==='Runtime.consoleAPICalled'){
                const text=message.params.args.map(a=>a.value ?? a.description ?? '').join(' ');
                (report.offscreenDiagnostics ??= []).push({level:message.params.type,text});
                if(message.params.type==='error')report.consoleErrors.push(text);
            }
            if(message.method==='Network.requestWillBeSent'){
                const url=new URL(message.params.request.url);
                if(['huggingface.co','hf-mirror.com','hf-mirror.net'].includes(url.host) || (url.host==='cdn.jsdelivr.net' && url.pathname.endsWith('.traineddata.gz')))report.modelRequests.push({source:url.host,file:url.pathname.split('/').pop(),target:'offscreen'});
            }
        } catch (error) {fail(new Error(`CDP JSON/event protocol error: ${error.message}`));}
    });
    try {
        await new Promise((resolve,reject)=>{
            rejectOpen = reject;
            openTimer = setTimeout(() => fail(new Error('CDP socket open timeout')),10000);
            socket.addEventListener('open',()=>{clearTimeout(openTimer); rejectOpen = undefined; resolve();},{once:true});
        });
        const {targetInfos}=await command('Target.getTargets');
        const target=targetInfos.find(target=>target.url.startsWith(`chrome-extension://${extensionId}/offscreen.html`));
        assert.ok(target,'Own isolated extension Offscreen target exists');
        const {sessionId}=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        await command('Network.enable',{},sessionId);
        await command('Runtime.enable',{},sessionId);
        if(blockedOfficial || blockedAll)await command('Network.setBlockedURLs',{urls:blockedAll?['https://huggingface.co/*','https://hf-mirror.com/*','https://hf-mirror.net/*']:['https://huggingface.co/*']},sessionId);
        socket.command=(method,params)=>command(method,params,sessionId);return socket;
    } catch (error) {fail(error); throw error;}
}

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Manga reader fixture</title><style>
body{margin:0;background:#171923;color:white;font:16px system-ui}.heading{padding:22px;text-align:center}
.zao-image-container{width:760px;margin:0 auto 50px}.zao-image{width:760px;height:1100px;display:block}
#decoy{width:500px;height:500px;display:block;margin:auto}
button{border:24px solid green!important;font:60px monospace!important;background:red!important}
</style></head><body><div class="heading">漫画连续翻译 · 原文 / 译文 · 滚动自动继续</div><main id="reader"></main><img id="decoy" alt="logo"><script>
window.addPage=(text,id)=>{
 const canvas=document.createElement('canvas');canvas.width=760;canvas.height=1100;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,760,1100);
 ctx.strokeStyle='#222';ctx.lineWidth=4;ctx.strokeRect(24,24,712,500);ctx.strokeRect(24,550,712,520);
 ctx.beginPath();ctx.ellipse(380,160,310,100,0,0,Math.PI*2);ctx.stroke();
 ctx.fillStyle='#111';ctx.textAlign='center';ctx.font='bold 36px Arial';ctx.fillText(text,380,150);
 ctx.font='32px Arial';ctx.fillText('Read every page',380,205);ctx.fillText('Scroll to continue',380,680);
 const wrap=document.createElement('div');wrap.className='zao-image-container';
 const image=document.createElement('img');image.className='zao-image';image.id=id;wrap.append(image);document.querySelector('#reader').append(wrap);
 canvas.toBlob(blob=>{image.src=URL.createObjectURL(blob)});
 return image;
};addPage('Welcome to FluentRead','page-one');addPage('Second manga page','page-two');addPage('Third manga page','page-three');
${readAheadTest || scrollStabilityTest || scrollIntentTest || cacheNavigationTest || tieredCacheTest || pageFeedbackTest ? "addPage('Fourth manga page','page-four');addPage('Fifth manga page','page-five');addPage('Sixth manga page','page-six');" : ''}
</script></body></html>`;
/** 夹具只绘制站点公开 DOM；canvas/background 复用现有适配，长图由生产 2048px 分段规则自行发现。 */
function recoverySurfaceFixture(surface) {
    assert.ok(['canvas','background','segments'].includes(surface));
    let alphaSource=null;
    if(recoveryCanvasAlpha||recoveryBackgroundAlpha){
        const input=fs.readFileSync(path.join(__dirname,'../../tests/fixtures/manga-chromatic/translucent-red-dialogue-overlay.png'));
        const sha256=createHash('sha256').update(input).digest('hex');
        assert.equal(sha256,'884f78dfc09b80aa8d5cf3e97e58235c1572b8fa7883487b74aa4dcac9affe38','Use the independently frozen transparent source without edits');
        alphaSource=`data:image/png;base64,${input.toString('base64')}`;
        const alpha={inputSha256:sha256,source:'existing independently designed red-alpha PNG; real production OCR/inpainting with controlled text transport',background:recoveryBackgroundAlpha?[29,65,83,255]:[23,25,35,255]};
        if(recoveryCanvasAlpha)report.recoveryCanvasAlpha=alpha;
        else report.recoveryBackgroundAlpha={...alpha,wordlessChildRegion:{x0:90,y0:730,x1:810,y1:850}};
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>Manga recovery ${surface} fixture</title><style>
body{margin:0;background:#171923;color:white;font:16px system-ui}.heading{padding:22px;text-align:center}
.zao-image-container{width:760px;margin:0 auto 50px}.manga-recovery-source{width:760px;height:1100px;display:block;padding:0;border:0}
${recoveryCanvasAlpha?'#reader>.zao-image-container:first-child{width:900px}#reader>.zao-image-container:first-child canvas{width:900px;height:auto;aspect-ratio:1}':''}
${recoveryBackgroundAlpha?'#reader>.zao-image-container:first-child{width:900px}#reader>.zao-image-container:first-child .manga-recovery-source{width:100%;height:auto;aspect-ratio:1;position:relative;background-color:rgb(29,65,83)}#recovery-host-caption,#recovery-host-action{position:absolute;left:12.444444%;width:30%;box-sizing:border-box;margin:0;padding:0;border:0!important;font:clamp(8px,1.6vw,16px)/1.1 system-ui!important;color:white!important;display:flex;align-items:center;justify-content:center;overflow:hidden}#recovery-host-caption{top:82.666667%;height:3.111111%;background:rgb(48,32,96)}#recovery-host-action{top:87.555556%;height:4.444444%;background:rgb(24,128,72)!important;cursor:pointer}':''}
button{border:24px solid green!important;font:60px monospace!important;background:red!important}
</style></head><body><div class="heading">漫画错误恢复 · ${surface}</div><main id="reader"></main><script>
(async()=>{
 const surface=${JSON.stringify(surface)},alphaSource=${JSON.stringify(alphaSource)},urls=[];
 addEventListener('pagehide',()=>urls.forEach(url=>URL.revokeObjectURL(url)),{once:true});
 const panel=(canvas,top,text)=>{
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,top,760,1100);
  ctx.strokeStyle='#222';ctx.lineWidth=4;ctx.strokeRect(24,top+24,712,500);ctx.strokeRect(24,top+550,712,520);
  ctx.beginPath();ctx.ellipse(380,top+160,310,100,0,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle='#111';ctx.textAlign='center';ctx.font='bold 36px Arial';ctx.fillText(text,380,top+150);
  ctx.font='32px Arial';ctx.fillText('Read every page',380,top+205);ctx.fillText('Scroll to continue',380,top+680);
 };
 const blobUrl=async canvas=>{const blob=await new Promise(resolve=>canvas.toBlob(resolve));if(!blob)throw new Error('Recovery fixture PNG encoding failed');const url=URL.createObjectURL(blob);urls.push(url);return url;};
 const sourceBlobUrl=data=>{const bytes=Uint8Array.from(atob(data.split(',')[1]),value=>value.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));urls.push(url);return url;};
 const append=element=>{const wrap=document.createElement('div');wrap.className='zao-image-container';
  if(surface==='canvas')wrap.setAttribute('data-viewer-full-screen-helper','');wrap.append(element);document.querySelector('#reader').append(wrap);};
 const texts=['Welcome to FluentRead','Second manga page','Third manga page'];
 if(surface==='segments'){
  const canvas=document.createElement('canvas');canvas.width=760;canvas.height=6144;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='white';ctx.fillRect(0,0,760,6144);
  texts.forEach((text,index)=>panel(canvas,index*2048,text));
  const image=document.createElement('img');image.className='zao-image manga-recovery-source';image.id='page-one';image.style.height='auto';
  image.src=await blobUrl(canvas);await image.decode();append(image);canvas.width=canvas.height=0;
 }else for(let index=0;index<3;index++){
  const canvas=document.createElement('canvas');canvas.width=760;canvas.height=1100;panel(canvas,0,texts[index]);
  if(index===0&&alphaSource){const source=new Image();source.src=alphaSource;await source.decode();canvas.width=canvas.height=900;canvas.getContext('2d').drawImage(source,0,0);canvas.setAttribute('style','touch-action:pan-y;transition:opacity 150ms linear');}
  if(surface==='canvas'){canvas.className='manga-recovery-source';canvas.id='page-'+index;canvas.setAttribute('data-type','contents');append(canvas);}
  else{const element=document.createElement('div');element.className='manga-recovery-source';element.id='page-'+index;
   const originalUrl=index===0&&${recoveryBackgroundAlpha}?sourceBlobUrl(alphaSource):await blobUrl(canvas);
   element.style.cssText='background-size:contain;background-repeat:no-repeat;background-position:50% 50%;background-origin:padding-box;background-image:url("'+originalUrl+'")';
   if(index===0&&${recoveryBackgroundAlpha}){const caption=document.createElement('span');caption.id='recovery-host-caption';caption.textContent='Original host content';
    const button=document.createElement('button');button.id='recovery-host-action';button.type='button';button.textContent='Original host action';element.append(caption,button);
    window.__recoveryHostClicks=[];element.addEventListener('click',event=>{if(event.target.closest('#recovery-host-action'))window.__recoveryHostClicks.push({trusted:event.isTrusted,target:event.target.id});});}
   append(element);canvas.width=canvas.height=0;}
 }
 window.__recoverySurfaceFixture={ready:true,surface,pages:3,sourceCount:surface==='segments'?1:3,
  naturalWidth:${recoveryCanvasAlpha||recoveryBackgroundAlpha?900:760},naturalHeight:${recoveryCanvasAlpha||recoveryBackgroundAlpha?900:"surface==='segments'?6144:1100"},segmentHeight:surface==='segments'?2048:null,
  sourceDimensions:[...document.querySelectorAll('.manga-recovery-source')].map((element,index)=>({width:element.naturalWidth||element.width||(${recoveryBackgroundAlpha}&&index===0?900:760),height:element.naturalHeight||element.height||(${recoveryBackgroundAlpha}&&index===0?900:1100)}))};
})().catch(error=>{window.__recoverySurfaceFixture={error:error.message};console.error(error);});
</script></body></html>`;
}
async function ui(hostId, code) {
    const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true}); let host;
    function visit(node) {
        const attrs = node.attributes || [];
        for (let i=0; i<attrs.length; i+=2) if (attrs[i] === 'id' && attrs[i+1] === hostId) host=node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
    }
    visit(tree.root); const shadow = host?.shadowRoots?.[0]; if (!shadow) return null;
    let objectId;
    try {objectId = (await cdp.send('DOM.resolveNode', {nodeId: shadow.nodeId,...(canvasContentPixels&&hostId===surfaceHost?{executionContextId:contentPixelContext}:{})})).object.objectId;}
    catch(error){if(error.message.includes('No node with given id'))return null;throw error;}
    try {
        const result=await cdp.send('Runtime.callFunctionOn', {objectId, functionDeclaration:`async function(){${code}}`, returnByValue:true, awaitPromise:true});
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    } finally {await cdp.send('Runtime.releaseObject', {objectId});}
}
const ball = code => ui('fluent-read-floating-ball-container', code);
const imageUi = code => ui('fluent-read-image-translation-root', code);
const mangaEntry = code => ui('fluent-read-manga-entry-container',code);
const surfaceHost=segmentReaderTest||(errorRecoveryTest&&errorRecoverySurface==='segments')?'fluent-read-manga-segment-container':
    backgroundReaderTest||(errorRecoveryTest&&errorRecoverySurface==='background')?'fluent-read-manga-background-container':'fluent-read-manga-canvas-container';
const canvasUi = code => ui(surfaceHost,code);
/** 先固定原站来源；激活后的样式只允许借背景图片，不得把自有译图当成新的原图。 */
async function backgroundSourceUrls() {
    const urls=await page.locator(readerSelector).evaluateAll(elements=>elements.map(element=>{
        const url=/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(getComputedStyle(element).backgroundImage)?.[1];
        if(!element.id||!url||new URL(url).origin!==location.origin)throw new Error('Background source must have its existing ID and same-origin blob URL');
        return {id:element.id,url};
    }));
    assert.equal(new Set(urls.map(source=>source.id)).size,urls.length,'Existing background source IDs are unique');return urls;
}
async function backgroundReceiptStyle(raw,url) {
    return page.evaluate(({raw,url})=>{const style=document.createElement('div').style;style.cssText=raw||'';style.setProperty('background-image',`url("${url}")`,'important');return style.cssText;},{raw,url});
}
async function backgroundSnapshot(source,originals) {
    return source.evaluate(async(element,originals)=>{
        const url=originals.find(source=>source.id===element.id)?.url;
        if(!url)throw new Error('Original background URL was not pinned before presentation');
        const image=new Image(),canvas=document.createElement('canvas');
        try{
            image.src=url;await image.decode();canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
            const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('Background source readback context unavailable');
            context.drawImage(image,0,0);let hash=2166136261;for(const value of context.getImageData(0,0,canvas.width,canvas.height).data)hash=Math.imul(hash^value,16777619);
            return {id:element.id,width:canvas.width,height:canvas.height,pixelHash:hash>>>0,sourceUrl:url,
                attributes:Object.fromEntries(element.getAttributeNames().sort().map(name=>[name,element.getAttribute(name)])),children:element.innerHTML,backgroundColor:getComputedStyle(element).backgroundColor};
        }finally{image.src='';canvas.width=canvas.height=0;}
    },originals);
}
/** 读取真实 CSS 译图地址及其 PNG；检查数据不通过固定画布层或生产私有状态。 */
async function backgroundPresentations(originals) {
    return page.locator(readerSelector).evaluateAll(async(elements,originals)=>{
        const sourceUrls=new Map(originals.map(source=>[source.id,source.url]));
        const results=[];
        for(const element of elements){
            const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
            const url=/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(style.backgroundImage)?.[1];
            const inline=/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(element.style.getPropertyValue('background-image'))?.[1];
            if(!url||url!==inline||element.style.getPropertyPriority('background-image')!=='important'||sourceUrls.get(element.id)===url
                ||!element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||rect.width<=0||rect.height<=0||rect.left>=innerWidth||rect.right<=0||rect.top>=innerHeight||rect.bottom<=0)continue;
            const image=new Image(),canvas=document.createElement('canvas');
            try{
                image.src=url;await image.decode();canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
                const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('Background PNG readback context unavailable');
                context.drawImage(image,0,0);let hash=2166136261;for(const value of context.getImageData(0,0,canvas.width,canvas.height).data)hash=Math.imul(hash^value,16777619);
                results.push({id:element.id,url,width:canvas.width,height:canvas.height,hash:hash>>>0,data:canvas.toDataURL('image/png'),
                    attributes:Object.fromEntries(element.getAttributeNames().sort().map(name=>[name,element.getAttribute(name)]))});
            }finally{image.src='';canvas.width=canvas.height=0;}
        }
        return results;
    },originals);
}
async function evaluateReaderElements(operation,value){
    if(!canvasContentPixels)return page.locator(readerSelector).evaluateAll(operation,value);
    assert.ok(contentPixelContext,'Own production content context exists before reading pixels');
    const result=await cdp.send('Runtime.evaluate',{contextId:contentPixelContext,expression:`(${operation.toString()})([...document.querySelectorAll(${JSON.stringify(readerSelector)})],${JSON.stringify(value)??'undefined'})`,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
}
async function wait(test, timeout=180000, allowFailure=false) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {if(await test())return;
        const failure=await imageUi(`const e=this.querySelector('.fr-image-feedback[data-phase="error"] .fr-image-status');return e?.textContent`);
        if(failure&&!allowFailure)throw new Error(`Image pipeline failed: ${failure}`);
        await page.waitForTimeout(200);}
    throw new Error(`Timed out: ${report.currentCase}; image controls: ${await imageUi('return Array.from(this.querySelectorAll(".fr-image-status")).map(e=>e.textContent).join(" | ")')}`);
}
async function verifyBackgroundReader() {
    assert.ok(liveSite,'Background reader smoke uses an explicitly supplied public chapter');
    const visibleSources=async()=>{const sources=[];for(const source of await page.locator(readerSelector).all())if(await source.evaluate(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}))sources.push(source);return sources;};
    const sources=await visibleSources();assert.ok(sources.length,'Visible public background sources are present');
    let originalUrls=await backgroundSourceUrls();
    const snapshot=(targets=sources,urls=originalUrls)=>Promise.all(targets.map(source=>backgroundSnapshot(source,urls)));
    const original=await snapshot();report.canvasSource=original;report.backgroundOriginalUrls=originalUrls;await screenshot('canvas-original');
    const outputs=()=>backgroundPresentations(originalUrls);
    const visible=async()=>(await outputs()).length;
    const noFixedCanvas=async()=>assert.equal((await canvasUi('return this.querySelectorAll("canvas").length'))??0,0,'Background output remains in its original CSS painting layer');
    const assertLeased=async(actual,expected,bitmaps)=>{
        assert.equal(actual.length,expected.length);
        for(let index=0;index<actual.length;index++){
            const source=expected[index],output=bitmaps.find(output=>output.id===source.id);
            if(actual[index].attributes.style===source.attributes.style){assert.deepEqual(actual[index],source);continue;}
            assert.ok(output,'Every changed background has its own decoded translated PNG');assert.equal(output.width,source.width);assert.equal(output.height,source.height);
            const style=await backgroundReceiptStyle(source.attributes.style,output.url);
            assert.deepEqual(actual[index],{...source,attributes:{...source.attributes,style}},'Original background pixels, child content and every attribute survive apart from the exact owned image longhand');
        }
    };
    const unchanged=async active=>{const actual=await snapshot();if(active)await assertLeased(actual,original,await outputs());else assert.deepEqual(actual,original);};
    const layout=()=>page.locator(readerSelector).evaluateAll(elements=>elements.map(element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return {id:element.id,style:element.getAttribute('style'),backgroundImage:style.backgroundImage,backgroundColor:style.backgroundColor,backgroundSize:style.backgroundSize,backgroundPosition:style.backgroundPosition,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};}));
    report.currentCase='public readable background translates in its original CSS layer while preserving original source pixels and host content';
    const started=Date.now();await toggle();
    await wait(async()=>await visible()>0&&await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'),300000);
    const first=await outputs();report.translatedCanvasPixels=first.map(({id,width,height,hash,url})=>({id,width,height,hash,url}));
    assert.ok(first.some(output=>original.some(source=>source.id===output.id&&source.pixelHash!==output.hash)),'Actual translated background PNG pixels differ from the pinned original');
    await unchanged(true);await noFixedCanvas();await assertQuietReading();
    report.canvasLayoutBeforeScreenshot=await layout();for(let index=0;index<first.length;index++)fs.writeFileSync(path.join(artifacts,`canvas-output-${index}.png`),Buffer.from(first[index].data.split(',')[1],'base64'));
    await screenshot('canvas-translated');report.canvasLayoutAfterScreenshot=await layout();report.canvasFirstPageMs=Date.now()-started;report.cases.push(report.currentCase);
    const operations=await ops();await page.mouse.move(400,200);await page.mouse.move(30,30);await page.waitForTimeout(1200);
    assert.ok(await visible()>0,'Translated background remains after pointer exit');await unchanged(true);assert.equal(await ops(),operations,'Original URL readback and stable layout do not repeat OCR');
    await screenshot('canvas-stable-after-pointer');report.canvasStableAfterPointerExit=true;report.sourceType='CSS background';
    report.currentCase='pause restores every background attribute and reactivation preserves the cached PNG and URL without OCR';
    const beforePause=await outputs();await toggle();await wait(async()=>await visible()===0);await unchanged(false);
    await toggle();await wait(async()=>await visible()>0);assert.equal(await ops(),operations);assert.deepEqual(await outputs(),beforePause,'Cached background output retains exact PNG, URL and attributes');await unchanged(true);report.cases.push(report.currentCase);
    let finalSources=sources,finalOriginal=original;
    report.currentCase='normal chapter turn translates a new original background through the same serial queue';
    const target=await page.locator(readerSelector).first().boundingBox();assert.ok(target&&target.width>80&&target.height>40,'Public background remains before a normal chapter turn');
    await page.mouse.move(Math.max(1,Math.min(1200,target.x+target.width/2)),Math.max(1,Math.min(700,target.y+target.height/2)));
    const paintUrls=()=>page.locator(readerSelector).evaluateAll(elements=>elements.flatMap(element=>{const r=element.getBoundingClientRect();return r.width>80&&r.height>40&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0?[{id:element.id,paint:getComputedStyle(element).backgroundImage}]:[];}));
    const beforePaint=await paintUrls();report.canvasTurn={paintBefore:beforePaint,originalBefore:original.map(({id,sourceUrl,pixelHash,width,height})=>({id,sourceUrl,pixelHash,width,height})),mode:canvasNextClickSelector?'normal-public-click':'normal-arrow-key'};
    for(let turn=0;turn<canvasTurnCount;turn++){if(canvasNextClickSelector)await page.locator(canvasNextClickSelector).click({position:{x:canvasNextClickPosition[0],y:canvasNextClickPosition[1]},timeout:15000});else await page.keyboard.press(canvasTurnKey);}
    await wait(async()=>{const current=await paintUrls();report.canvasTurn.paintAfter=current;return current.length>0&&JSON.stringify(current)!==JSON.stringify(beforePaint);},10000);
    await wait(async()=>await ops()>operations&&await visible()>0&&await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'),300000);
    const turned=await outputs(),turnedOperations=await ops();await noFixedCanvas();await screenshot('canvas-next-pages');
    // 暂停后读取真正的新原站来源，不能把测试自己的新译图 URL 当作翻页依据。
    await toggle();await wait(async()=>await page.locator(readerSelector).evaluateAll((elements,urls)=>elements.every(element=>!urls.includes(/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(getComputedStyle(element).backgroundImage)?.[1])),turned.map(output=>output.url)));
    originalUrls=await backgroundSourceUrls();finalSources=await visibleSources();finalOriginal=await snapshot(finalSources);
    report.canvasTurn.originalAfter=finalOriginal.map(({id,sourceUrl,pixelHash,width,height})=>({id,sourceUrl,pixelHash,width,height}));
    assert.notDeepEqual(report.canvasTurn.originalAfter,report.canvasTurn.originalBefore,'A real original page identity or its pixels changed on the public turn');
    assert.ok(turned.some(output=>finalOriginal.some(source=>source.id===output.id&&source.pixelHash!==output.hash)),'Turned output differs from its actual restored original source');
    for(const output of turned){const source=finalOriginal.find(source=>source.id===output.id);assert.ok(source,'Translated turn output belongs to a current original');assert.deepEqual(output.attributes,{...source.attributes,style:await backgroundReceiptStyle(source.attributes.style,output.url)},'Turned source permits only the image presentation receipt');}
    await toggle();await wait(async()=>await visible()>0);assert.equal(await ops(),turnedOperations);assert.deepEqual(await outputs(),turned,'Returning the turned background uses the same decoded PNG/URL without OCR');report.cases.push(report.currentCase);
    report.currentCase='master switch restores background attributes and removes translation UI';
    await patch({on:false});await wait(async()=>await visible()===0);assert.deepEqual(await snapshot(finalSources),finalOriginal);await wait(async()=>await page.locator('#'+surfaceHost).count()===0);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.cases.push(report.currentCase);focusGuard();
}
async function verifyCanvasReader() {
    if(backgroundReaderTest)return verifyBackgroundReader();
    assert.ok(liveSite,'Canvas reader smoke uses an explicitly supplied public chapter');
    const visibleSurfaces=()=>canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>c.style.display === "block").length');
    const sources=[];
    for(const canvas of await page.locator(readerSelector).all())if(await canvas.evaluate(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}))sources.push(canvas);
    assert.ok(sources.length,'Visible public chapter surfaces are present');
    const mainSnapshot=()=>Promise.all(sources.map(source=>source.evaluate(async c=>{
        let target=c, image;
        try {
            if(c.tagName!=='CANVAS') {
                const source=/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(getComputedStyle(c).backgroundImage)?.[1];
                if(!source)throw new Error('No public blob background source');
                image=new Image();image.src=source;await image.decode();target=document.createElement('canvas');target.width=image.naturalWidth;target.height=image.naturalHeight;target.getContext('2d').drawImage(image,0,0);
            }
            const pixels=target.getContext('2d').getImageData(0,0,target.width,target.height).data;let hash=2166136261;
            for(const value of pixels)hash=Math.imul(hash^value,16777619);
            return {id:c.id,width:target.width,height:target.height,style:c.getAttribute('style'),className:c.className,hash:hash>>>0};
        } finally {if(image){image.src='';target.width=target.height=0;}}
    })));
    const snapshot=canvasContentPixels?()=>evaluateReaderElements(elements=>elements.filter(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}).map(c=>{
        const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const value of pixels)hash=Math.imul(hash^value,16777619);
        return {id:c.id,width:c.width,height:c.height,style:c.getAttribute('style'),className:c.className,hash:hash>>>0};
    })):mainSnapshot;
    const original=await snapshot();report.canvasSource=original;await screenshot('canvas-original');
    const leasedStyles=await page.evaluate(styles=>styles.map(raw=>{const style=document.createElement('canvas').style;style.cssText=raw||'';style.setProperty('transition-property','none','important');style.setProperty('opacity','0','important');return style.cssText;}),original.map(source=>source.style));
    const unchanged=async(allowReceipt=false)=>{
        const actual=await snapshot();assert.equal(actual.length,original.length);
        const visible=allowReceipt&&!backgroundReaderTest?await canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>{const r=c.getBoundingClientRect();return c.isConnected&&c.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&getComputedStyle(c).display!=="none"&&r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}).map(c=>{const r=c.getBoundingClientRect();return {width:c.width,height:c.height,x:r.x,y:r.y,w:r.width,h:r.height};})'):[];
        for(let index=0;index<actual.length;index++){
            const leased=allowReceipt&&!backgroundReaderTest&&actual[index].style!==original[index].style;
            const expected=leased?{...original[index],style:leasedStyles[index]}:original[index];
            assert.deepEqual(actual[index],expected,'Canvas pixels and attributes are unchanged apart from the exact owned visibility receipt');
            if(leased){
                const rect=await sources[index].evaluate(c=>{const r=c.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
                const match=visible.findIndex(output=>output.width===actual[index].width&&output.height===actual[index].height&&Object.keys(rect).every(key=>Math.abs(output[key]-rect[key])<.5));
                assert.ok(match>=0,'Each hidden source must have its own visible translated surface with matching dimensions and geometry');visible.splice(match,1);
            }
        }
    };
    report.currentCase=`public readable ${backgroundReaderTest?'background':'canvas'} runs real manga OCR and translated overlay without changing the source`;
    const started=Date.now();await toggle();
    await wait(async()=>(await visibleSurfaces())>0 && await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'),300000);
    report.translatedCanvasPixels=await canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>c.style.display === "block").map(c=>{const data=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const v of data)hash=Math.imul(hash^v,16777619);return {width:c.width,height:c.height,hash:hash>>>0}})');
    assert.ok(report.translatedCanvasPixels.some(output=>!original.some(source=>source.hash===output.hash)),'Translated canvas pixels differ from the original');
    await unchanged(true);await assertQuietReading();
    const layout=()=>canvasUi('return [...this.querySelectorAll("canvas")].map(c=>{const r=c.getBoundingClientRect();return {style:c.style.cssText,rect:{x:r.x,y:r.y,width:r.width,height:r.height},parentStyle:c.parentNode.host.style.cssText}})');
    report.canvasLayoutBeforeScreenshot=await layout();
    const outputs=await canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>c.style.display === "block").map(c=>c.toDataURL("image/png"))');
    for(let index=0;index<outputs.length;index++)fs.writeFileSync(path.join(artifacts,`canvas-output-${index}.png`),Buffer.from(outputs[index].split(',')[1],'base64'));
    await screenshot('canvas-translated');report.canvasLayoutAfterScreenshot=await layout();
    report.canvasPageLayout=await page.locator(readerSelector).evaluateAll(cs=>cs.map(c=>{const r=c.getBoundingClientRect();const hit=document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2);return {width:c.width,height:c.height,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?{tag:hit.tagName,id:hit.id,class:hit.className}:null,parent:c.parentElement.outerHTML.slice(0,1200)}}));
    report.canvasFirstPageMs=Date.now()-started;report.cases.push(report.currentCase);
    const operations=await ops();
    await page.mouse.move(400,200);await page.mouse.move(30,30);await page.waitForTimeout(1200);
    assert.ok((await visibleSurfaces())>0,'The translated canvas remains visible after pointer exit and source pixel readback');
    await unchanged(true);assert.equal(await ops(),operations,'Unchanged canvas does not repeat OCR after resampling');
    await screenshot('canvas-stable-after-pointer');report.canvasStableAfterPointerExit=true;report.sourceType=backgroundReaderTest?'CSS background':'canvas';
    report.currentCase='pause restores the original canvas and repeated activation reuses the translated page';
    await toggle();await wait(async()=>(await visibleSurfaces())===0);await unchanged();
    await toggle();await wait(async()=>(await visibleSurfaces())>0);assert.equal(await ops(),operations);report.cases.push(report.currentCase);
    if(!canvasFirstSpreadOnly){
    report.currentCase='normal chapter turn translates new canvas pages through the same serial queue';
    // 先把指针移回公开正文，再发送源站翻页键；不把未发生的翻页误报成 OCR 等待。
    const target=await page.locator(readerSelector).first().boundingBox();
    assert.ok(target&&target.width>80&&target.height>40,'Public chapter surface remains available before turning');
    await page.mouse.move(Math.max(1,Math.min(1200,target.x+target.width/2)),Math.max(1,Math.min(700,target.y+target.height/2)));
    const fingerprint=()=>evaluateReaderElements((elements,background)=>elements.flatMap(element=>{
        const rect=element.getBoundingClientRect();if(rect.width<=80||rect.height<=40||rect.left>=innerWidth||rect.right<=0||rect.top>=innerHeight||rect.bottom<=0)return [];
        let hash=2166136261;
        if(background){for(const char of getComputedStyle(element).backgroundImage)hash=Math.imul(hash^char.charCodeAt(0),16777619);}
        else {const context=element.getContext('2d');for(let y=0;y<8;y++)for(let x=0;x<8;x++)for(const value of context.getImageData(Math.floor((x+.5)*element.width/8),Math.floor((y+.5)*element.height/8),1,1).data)hash=Math.imul(hash^value,16777619);}
        return [{width:element.width||Math.round(rect.width),height:element.height||Math.round(rect.height),hash:hash>>>0}];
    }),backgroundReaderTest);
    const beforeTurn=await fingerprint();report.canvasTurn={before:beforeTurn,mode:canvasNextClickSelector?'normal-public-click':'normal-arrow-key',activeElement:await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id}))};
    for(let turn=0;turn<canvasTurnCount;turn++){
        if(canvasNextClickSelector)await page.locator(canvasNextClickSelector).click({position:{x:canvasNextClickPosition[0],y:canvasNextClickPosition[1]},timeout:15000});
        else await page.keyboard.press(canvasTurnKey);
    }
    await wait(async()=>{const after=await fingerprint();report.canvasTurn.after=after;return after.length>0&&JSON.stringify(after)!==JSON.stringify(beforeTurn);},10000);
    await wait(async()=>(await ops())>operations && await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'),300000);
    report.canvasTurn.afterCompleted=await fingerprint();
    assert.ok((await visibleSurfaces())>0);await screenshot('canvas-next-pages');report.cases.push(report.currentCase);
    }else{
        report.firstSpreadScope='Initial public spread only; no loaded-next-page or whole-chapter translation acceptance.';
        if(canvasLoadingSelector){
            report.currentCase='same chapter native loading keeps the activated reader waiting without old overlays';
            for(let turn=0;turn<canvasTurnCount;turn++)await page.keyboard.press(canvasTurnKey);
            await wait(async()=>await page.locator(canvasLoadingSelector).evaluateAll(elements=>elements.some(e=>{const r=e.getBoundingClientRect();return r.width>80&&r.height>40;}))
                && await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed") === "true"'),15000);
            await page.waitForTimeout(1200);
            report.nativeLoading={selector:canvasLoadingSelector,active:await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed")'),sources:await evaluateReaderElements(elements=>elements.map(c=>{
                const context=c.getContext('2d');let nonblank=false;for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(context.getImageData(Math.floor((x+.5)*c.width/8),Math.floor((y+.5)*c.height/8),1,1).data.some(value=>value>0))nonblank=true;
                return {width:c.width,height:c.height,nonblank};
            }))};
            assert.equal(report.nativeLoading.active,'true');assert.equal(await visibleSurfaces(),0,'Old translated spread is removed during native loading');
            await screenshot('canvas-native-loading-wait');report.cases.push(report.currentCase);
        }
    }
    report.currentCase='master switch restores the chapter and removes canvas translation UI';
    await patch({on:false});await wait(async()=>await page.locator('#'+surfaceHost).count()===0);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.cases.push(report.currentCase);focusGuard();
}
async function verifySegmentReader() {
    const source=page.locator(readerSelector).first();
    await source.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await wait(async()=>await source.evaluate(i=>i.complete&&i.naturalWidth>=80&&i.naturalHeight>4096),30000);
    const snapshot=()=>source.evaluate(i=>{
        let hash=2166136261;for(const char of [i.currentSrc,i.src,i.getAttribute('srcset'),i.getAttribute('sizes')].join('|'))hash=Math.imul(hash^char.charCodeAt(0),16777619);
        return {width:i.naturalWidth,height:i.naturalHeight,sourceHash:hash>>>0,style:i.getAttribute('style'),className:i.className};
    });
    const original=await snapshot(),step=Math.min(2048,Math.floor(6_000_000/original.width)-512);
    assert.ok(original.height>(segmentStart+2)*step,'The selected public strip contains two requested reading segments');report.segmentSource={...original,step,start:segmentStart};
    const scroll=async index=>{
        await source.evaluate((i,{index,step})=>{
            let parent=i.parentElement;
            while(parent&&!(parent.scrollHeight>parent.clientHeight&&/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)))parent=parent.parentElement;
            const rect=i.getBoundingClientRect(),top=parent?Math.max(0,parent.getBoundingClientRect().top):0;
            const delta=rect.top+index*step*rect.height/i.naturalHeight-top+1;
            (parent||window).scrollBy({top:delta,behavior:'instant'});
        },{index,step});
        await page.waitForTimeout(400);
    };
    const visible=()=>canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>c.style.display==="block").map(c=>({width:c.width,height:c.height,top:c.getBoundingClientRect().top,style:c.style.cssText}))');
    const saveOutputs=async name=>{
        const outputs=await canvasUi('return [...this.querySelectorAll("canvas")].filter(c=>c.style.display==="block").map(c=>c.toDataURL("image/png"))');
        report.segmentOutputs??=[];
        for(let index=0;index<outputs.length;index++){const file=path.join(artifacts,`${name}-output-${index}.png`);fs.writeFileSync(file,Buffer.from(outputs[index].split(',')[1],'base64'));report.segmentOutputs.push(file);}
    };
    const idle=()=>ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy")==="false"');
    await scroll(segmentStart);await screenshot('segment-original');
    report.currentCase='long public strip keeps natural width and translates the current reading segment';
    const started=Date.now(),before=await ops();await toggle();
    await wait(async()=>(await ops())>before&&await idle(),300000);
    const first=await visible();assert.ok(first?.length,'The selected public reading segment contains translated text');
    assert.ok(first.every(c=>c.width===original.width&&c.height<=step),'Displayed segments preserve source width and bounded height');
    report.segmentFirst={durationMs:Date.now()-started,outputs:first,operations:await ops()};assert.deepEqual(await snapshot(),original);await assertQuietReading();await saveOutputs('segment-first');await screenshot('segment-translated');report.cases.push(report.currentCase);
    report.currentCase='pause restores the original strip and resume immediately reuses the translated segment';
    const completed=await ops();await toggle();await wait(async()=>!(await visible())?.length);assert.deepEqual(await snapshot(),original);
    await toggle();await wait(async()=>(await visible())?.length>0,10000);assert.equal(await ops(),completed);report.cases.push(report.currentCase);
    report.currentCase='scrolling to the following part of the same image uses the existing serial queue';
    const nextStarted=Date.now();await scroll(segmentStart+1);await wait(async()=>(await ops())>completed&&await idle(),300000);
    const next=await visible();assert.ok(next?.length);assert.ok(next.every(c=>c.width===original.width&&c.height<=step));
    report.segmentNext={durationMs:Date.now()-nextStarted,outputs:next,operations:await ops()};assert.deepEqual(await snapshot(),original);await assertQuietReading();await saveOutputs('segment-next');await screenshot('segment-next');report.cases.push(report.currentCase);
    report.currentCase='returning to a completed segment restores its overlay without repeating recognition';
    const afterNext=await ops();await scroll(segmentStart);await wait(async()=>(await visible())?.length>0,10000);assert.equal(await ops(),afterNext);assert.deepEqual(await snapshot(),original);await screenshot('segment-return');report.cases.push(report.currentCase);
    report.currentCase='the master switch removes segmented overlays and leaves the host image unchanged';
    await patch({on:false});await wait(async()=>await page.locator('#'+surfaceHost).count()===0);assert.deepEqual(await snapshot(),original);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.cases.push(report.currentCase);focusGuard();
}
async function toggle() {
    await activateVisible(page);
    if(ordinaryImageQuality){
        const image=page.locator('.zao-image').first(),bounds=await image.boundingBox();assert.ok(bounds);
        await page.mouse.move(bounds.x+Math.min(bounds.width/2,150),Math.max(5,bounds.y+Math.min(80,bounds.height/2)));
        await wait(async()=>await imageUi(`return [...this.querySelectorAll('.fr-image-controls:not([hidden]) .fluent-read-image-translation-button')].some(b=>getComputedStyle(b).display!=='none'&&b.getBoundingClientRect().width>0)`),10000);
        const point=await imageUi(`const b=[...this.querySelectorAll('.fr-image-controls:not([hidden]) .fluent-read-image-translation-button')].find(b=>getComputedStyle(b).display!=='none'&&b.getBoundingClientRect().width>0);const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=this.elementFromPoint(x,y);return {x,y,viewport:{width:innerWidth,height:innerHeight},hit:hit===b||b.contains(hit)};`);
        assert.ok(point.hit&&point.x>=0&&point.x<point.viewport.width&&point.y>=0&&point.y<point.viewport.height,'Ordinary action is visible and hit-testable');
        await page.mouse.click(point.x,point.y);return;
    }
    const point=await ball(`const b=this.querySelector('.floating-ball-manga');if(!b)return null;const r=b.getBoundingClientRect(),clipped=getComputedStyle(b).clipPath!=='none',left=this.querySelector('.fr-floating-ball').dataset.position==='left';return {x:r.x+r.width*(clipped?(left ? .75 : .25):.5),y:r.y+r.height/2}`);
    assert.ok(point,'Manga button exists');await page.mouse.move(point.x,point.y);
    await wait(async()=>await ball('return this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),3000);
    await page.waitForTimeout(500);
    const expanded=await ball(`const r=this.querySelector('.floating-ball-manga').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    await page.mouse.move(expanded.x,expanded.y);await page.waitForTimeout(150);
    await page.mouse.click(expanded.x,expanded.y);
}
async function ops() {return worker.evaluate(()=>globalThis.__mangaTest.operations.length);}
async function scrollReaderImage(index) {
    if(readerNextSelector){
        assert.ok(index>=readerCurrentIndex,'Normal page-turn samples move forward through observed body images');
        while(readerCurrentIndex<index){
            await page.locator(readerNextSelector).click({timeout:15000});readerCurrentIndex++;
            await page.locator(readerSelector).nth(readerCurrentIndex).waitFor({state:'visible',timeout:15000});
        }
    }
    const image=page.locator(readerSelector).nth(index);
    const anchor=page.locator(readerScrollSelector||readerSelector).nth(index);
    await anchor.waitFor({state:'attached'});
    await anchor.scrollIntoViewIfNeeded();
    await image.waitFor({state:'visible'});
    await wait(async()=>await image.evaluate(i=>i.complete&&i.naturalWidth>=80),30000);
    // 懒加载完成后对齐正文顶部，避免只露出页尾便把上页当成当前质量样本。
    await image.evaluate(i=>i.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'}));
}
async function visibleReaderImageSource() {
    return page.locator(readerSelector).evaluateAll(images=>{
        const index=images.findIndex(i=>{
            const r=i.getBoundingClientRect();return i.complete&&i.naturalWidth>=80&&i.naturalHeight>=40
                &&r.width>80&&r.height>40&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;
        });
        return index<0?null:{index,src:images[index].src};
    });
}
async function verifyPagedImageReader() {
    let sourceIndex=0;
    const source=()=>page.locator(readerSelector).nth(sourceIndex);
    const selectVisibleSource=async()=>{
        if(!imageVisibleSource)return true;
        const image=await visibleReaderImageSource();
        if(!image)return false;sourceIndex=image.index;return true;
    };
    const snapshot=()=>source().evaluate(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style'),width:i.naturalWidth,height:i.naturalHeight}));
    const complete=()=>source().evaluate(i=>i.complete&&i.naturalWidth>=80);
    const active=()=>ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed")');
    const displayed=()=>source().evaluate(i=>i.style.opacity==='0');
    const settled=()=>ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy") === "false"');
    const dismissNotice=async()=>{
        if(!readerDismissSelector)return;
        for(const frame of page.frames()){
            const control=frame.locator(readerDismissSelector).first();
            if(await control.isVisible().catch(()=>false)){
                await control.click({timeout:5000});
                await control.waitFor({state:'hidden',timeout:5000});
                (report.readerDismissals??=[]).push({selector:readerDismissSelector,frameOrigin:new URL(frame.url()).origin});
            }
        }
    };
    const pagedToggle=async()=>{await dismissNotice();await toggle();await dismissNotice();};
    const saveBitmaps=async stage=>{
        const outputs=await imageUi(`return [...this.querySelectorAll('.fluent-read-image-translation-bitmap')].map(surface=>{
            const r=surface.getBoundingClientRect();let data='',pixelReadError='';
            try{data=surface.tagName==='CANVAS'?surface.toDataURL('image/png'):surface.src;}catch(error){pixelReadError=error.name;}
            return {width:surface.width||surface.naturalWidth,height:surface.height||surface.naturalHeight,
                rect:{x:r.x,y:r.y,width:r.width,height:r.height},data,pixelReadError};
        })`);
        assert.ok(outputs.length>0,'Own production image result is present');
        for(const [index,output] of outputs.entries()){
            const file=path.join(artifacts,`${stage}-paged-output-${index}.png`);
            let mode='native-result-png',clip;
            if(output.data.startsWith('data:image/png;base64,'))fs.writeFileSync(file,Buffer.from(output.data.split(',')[1],'base64'));
            else{
                const viewport=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight})),r=output.rect,x=Math.max(0,r.x),y=Math.max(0,r.y);
                clip={x,y,width:Math.min(viewport.width,r.x+r.width)-x,height:Math.min(viewport.height,r.y+r.height)-y};
                if(clip.width<=40||clip.height<=40)continue;
                focusGuard();await dismissNotice();await page.screenshot({path:file,clip});mode='visible-screen-png';
            }
            (report.pagedImageOutputs??=[]).push({stage,index,width:output.width,height:output.height,rect:output.rect,pixelReadError:output.pixelReadError,mode,clip,file});
        }
    };
    await wait(selectVisibleSource,30000);
    const original=await snapshot();report.pagedImages.initialUrl=page.url();report.pagedImages.visibleSource=imageVisibleSource;report.pageDurationsMs=[];await captureSource(source(),'01');
    report.currentCase='paged image translates the visible public page';
    const previous=await ops(),start=Date.now();await pagedToggle();await wait(async()=>await ops()>previous&&await settled()&&await displayed());
    await dismissNotice();assert.equal(await active(),'true');report.pageDurationsMs.push({page:1,ms:Date.now()-start});await assertQuietReading();await screenshot('01-paged-translated',dismissNotice);await saveBitmaps('01');report.cases.push(report.currentCase);
    report.currentCase='paged image pauses to the unchanged original and resumes without OCR';
    await pagedToggle();await wait(async()=>!await displayed());assert.deepEqual(await snapshot(),original);
    const before=await ops();await pagedToggle();await wait(displayed);assert.equal(await ops(),before);await assertQuietReading();report.cases.push(report.currentCase);
    report.currentCase='normal page turn keeps continuous mode active and translates the new source';
    await dismissNotice();const firstUrl=page.url(),firstSource=original.src,secondStart=Date.now();await page.keyboard.press(imageTurnKey);
    await wait(async()=>await selectVisibleSource()&&await complete()&&(await snapshot()).src!==firstSource&&!await displayed(),30000);
    const secondOriginal=await snapshot();await captureSource(source(),'02');await wait(async()=>await ops()>before&&await settled()&&await displayed());
    assert.equal(await active(),'true');
    if(imageStableUrl)assert.equal(page.url(),firstUrl);else assert.notEqual(page.url(),firstUrl);
    report.pagedImages.urls=[firstUrl,page.url()];
    await dismissNotice();report.pageDurationsMs.push({page:2,ms:Date.now()-secondStart});await assertQuietReading();await screenshot('02-paged-translated',dismissNotice);await saveBitmaps('02');report.cases.push(report.currentCase);
    report.currentCase='paged image restores the second source and the master switch removes overlays';
    await pagedToggle();await wait(async()=>!await displayed());assert.deepEqual(await snapshot(),secondOriginal);
    await patch({on:false});await wait(async()=>await page.locator('#fluent-read-image-translation-root').count()===0);
    assert.equal(await source().evaluate(i=>i.style.opacity),'');auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
    report.cases.push(report.currentCase);focusGuard();
}
async function activateVisible(target) {
    focusGuard();await activateExtensionTabWithoutForeground(launched.context,target);focusGuard();
    const tabId=target.url().startsWith('chrome-extension://')?await target.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();if(!tab?.id)throw new Error('Owned extension test tab is missing');return tab.id;}):null;
    const deadline=Date.now()+10000;let state,url;
    do {
        url=target.url();
        state=await worker.evaluate(async({url,tabId})=>{const tab=tabId?await chrome.tabs.get(tabId):(await chrome.tabs.query({})).find(tab=>tab.url===url);if(!tab)return null;const window=await chrome.windows.get(tab.windowId);return {active:tab.active,windowState:window.state,windowFocused:window.focused};},{url,tabId});
        if(state)break;await target.waitForTimeout(100);
    } while(Date.now()<deadline);
    assert.ok(state,'Owned browser tab must be found within ten seconds');
    state.documentVisibility=await target.evaluate(()=>document.visibilityState);
    assert.deepEqual(state,{active:true,windowState:'normal',windowFocused:false,documentVisibility:'visible'},'Reading checks require an actual selected and visible background tab');
    (report.tabVisibility??=[]).push({url,...state});
}
async function gotoVisible(target,url,options) {const response=await target.goto(url,options);await activateVisible(target);return response;}
async function screenshot(name,beforeCapture) {
    await activateVisible(page);await page.mouse.move(30,30);await page.waitForTimeout(300);if(beforeCapture)await beforeCapture();
    const file=path.join(artifacts,`${name}.png`);
    if(errorRecoveryTest&&recoveryViewport){
        // 手动 CDP CSS 视口不属于 Playwright 的 viewport 状态；直接捕获，避免其截图端口恢复外层尺寸。
        const result=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});fs.writeFileSync(file,Buffer.from(result.data,'base64'));
        assert.deepEqual(await page.evaluate(()=>({width:innerWidth,height:innerHeight})),recoveryViewport,'Recovery screenshot preserves the emulated CSS viewport');
    }else await page.screenshot({path:file});
    report.screenshots.push(file);
}
async function toolScreenshot(name){
    await page.mouse.move(30,30);
    const box=await ball(`const r=this.querySelector('.floating-ball-manga').getBoundingClientRect();return {x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16}`);
    const file=path.join(artifacts,`button-${name}.png`);await page.screenshot({path:file,clip:box});report.screenshots.push(file);
    const metrics=await ball(`const b=this.querySelector('.floating-ball-manga'),c=b.querySelector('.manga-check');return {button:b.getBoundingClientRect().width,badge:c?.getBoundingClientRect().width,pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy')}`);
    report.buttonStates??={};report.buttonStates[name]=metrics;
}
async function captureSource(image, name) {
    await image.evaluate(i=>i.complete && i.naturalWidth ? undefined : new Promise((resolve,reject)=>{i.addEventListener('load',resolve,{once:true});i.addEventListener('error',reject,{once:true});}));
    const source = await image.evaluate(i=>{
        const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);
        const dimensions={width:i.naturalWidth,height:i.naturalHeight};
        try {return {...dimensions,data:c.toDataURL('image/png').split(',')[1]};}
        catch(error){if(error.name!=='SecurityError')throw error;return {...dimensions,pixelError:error.name};}
    });
    const file=path.join(artifacts,`${name}-original.png`);
    if(source.data)fs.writeFileSync(file,Buffer.from(source.data,'base64'));
    else {focusGuard();await image.screenshot({path:file});}
    (report.sourceCaptures??=[]).push({name,file,width:source.width,height:source.height,method:source.data?'natural image pixels':'displayed element screenshot',pixelError:source.pixelError});
}
async function patch(config) {
    return popup.evaluate(async config=>{
        const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
        const current=read.value;
        const response=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config,
            expected:Object.fromEntries(Object.keys(config).map(key=>[key,current[key]])),
            clientId:'manga-browser-test',sequence:Date.now(),baseRevision:current.__fluentConfigRevision||0});
        if(!response.success)throw new Error(response.error);
    },config);
}
async function assertQuietReading() {
    if(ordinaryImageQuality){
        assert.equal(Boolean(await mangaEntry('return !!this.querySelector(".fr-manga-entry")')),false,'Ordinary mode does not open manga panels');
        assert.notEqual(await imageUi('return [...this.querySelectorAll(".fr-image-feedback")].some(e=>!e.hidden&&e.dataset.manga==="true")'),true,'Ordinary mode does not use manga status');
        return;
    }
    assert.equal(await mangaEntry('return !!this.querySelector(".fr-manga-entry")'),false,'No automatic reader panel');
    assert.notEqual(await imageUi('return [...this.querySelectorAll(".fr-image-feedback")].some(e=>!e.hidden && (e.dataset.manga!=="true" || e.dataset.phase!=="loading" || !!e.querySelector("button")))'),true,'Only noninteractive per-page manga status may appear');
    assert.notEqual(await imageUi('return [...this.querySelectorAll(".fr-image-controls")].some(e=>!e.hidden && getComputedStyle(e).display!=="none")'),true,'No per-image original, text or cancel controls while reading');
}

/** 只注入文字传输失败；识别、页面状态、可信点击和重试继续执行生产实现。 */
async function verifyErrorRecovery() {
    const kind=errorRecoverySurface, sources=page.locator(readerSelector);
    const recoveryUi=code=>ui(kind==='image'?'fluent-read-image-translation-root':surfaceHost,code);
    const sourceFor=index=>sources.nth(kind==='segments'?0:index-1);
    if(recoveryViewport){
        // 只模拟页面 CSS 视口；第二屏外层浏览器仍为正常尺寸且不激活。
        await cdp.send('Emulation.setDeviceMetricsOverride',{...recoveryViewport,deviceScaleFactor:1,mobile:false});
        await page.addStyleTag({content:'.zao-image-container{max-width:100%;margin-bottom:calc(100vh + 50px);}.zao-image,.manga-recovery-source{width:100%;height:auto;max-width:100%;}.manga-recovery-source:not(img):not(canvas){aspect-ratio:760/1100;}#decoy{display:none;}.heading{font-size:14px;padding:12px;}'});
        const actual=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
        assert.deepEqual(actual,recoveryViewport,'Requested recovery CSS viewport is actually rendered');
    }
    if(recoveryRtl)await page.evaluate(()=>{document.documentElement.dir='rtl';});
    report.recoveryEnvironment={viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),rtl:recoveryRtl,longDetails:recoveryLongDetails};
    await sources.first().waitFor();
    if(kind==='image'||kind==='segments')await page.waitForFunction(selector=>[...document.querySelectorAll(selector)].every(image=>image.complete&&image.naturalWidth>=80),readerSelector);
    const originalBackgrounds=kind==='background'?await backgroundSourceUrls():[];
    const snapshot=source=>kind==='background'?backgroundSnapshot(source,originalBackgrounds):source.evaluate(async(element,kind)=>{
        let target=element,ownedImage;
        try{
            if(kind!=='canvas'){
                let image=element;
                if(kind==='background'){
                    const url=/^url\(["']?(blob:[^"')]+)["']?\)$/.exec(getComputedStyle(element).backgroundImage)?.[1];
                    if(!url||new URL(url).origin!==location.origin)throw new Error('Recovery background must be a same-origin blob');
                    ownedImage=image=new Image();image.src=url;await image.decode();
                }
                target=document.createElement('canvas');target.width=image.naturalWidth;target.height=image.naturalHeight;
                const context=target.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
            }
            const data=target.getContext('2d',{willReadFrequently:true}).getImageData(0,0,target.width,target.height).data;
            let hash=2166136261;for(const value of data)hash=Math.imul(hash^value,16777619);
            return {id:element.id,width:target.width,height:target.height,pixelHash:hash>>>0,
                attributes:Object.fromEntries(element.getAttributeNames().sort().map(name=>[name,element.getAttribute(name)]))};
        }finally{if(target!==element)target.width=target.height=0;if(ownedImage)ownedImage.src='';}
    },kind);
    const originals=[];for(let index=0;index<await sources.count();index++)originals.push(await snapshot(sources.nth(index)));
    if(recoveryBackgroundAlpha){
        const url=originalBackgrounds.find(source=>source.id===originals[0].id).url;
        const sha=await page.evaluate(async url=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch(url)).arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join(''),url);
        assert.equal(sha,report.recoveryBackgroundAlpha.inputSha256,'Background blob contains the exact frozen PNG bytes, without a canvas re-encode');report.recoveryBackgroundAlpha.originalBlobSha256=sha;
    }
    const expectedOriginals=structuredClone(originals);
    const leasedStyles=kind==='canvas'?await page.evaluate(styles=>styles.map(raw=>{const style=document.createElement('canvas').style;style.cssText=raw||'';style.setProperty('transition-property','none','important');style.setProperty('opacity','0','important');return style.cssText;}),originals.map(source=>source.attributes.style)):[];
    report.recoverySourceOriginals=originals;
    const unchanged=async(index,allowImageHiding=false)=>{
        const actual=await snapshot(sourceFor(index)),original=expectedOriginals[kind==='segments'?0:index-1];
        if(kind==='image'&&allowImageHiding){
            const withoutStyle=value=>({...value,attributes:Object.fromEntries(Object.entries(value.attributes).filter(([key])=>key!=='style'))});
            assert.deepEqual(withoutStyle(actual),withoutStyle(original),'Recovery preserves original pixels and source attributes');
        }else if(kind==='canvas'&&allowImageHiding&&actual.attributes.style!==original.attributes.style){
            assert.deepEqual(actual,{...original,attributes:{...original.attributes,style:leasedStyles[index-1]}},'Active Canvas permits only the exact owned visibility receipt; pixels and all other attributes remain unchanged');
        }else if(kind==='background'&&allowImageHiding&&actual.attributes.style!==original.attributes.style){
            const bitmap=(await visibleBitmaps()).find(output=>output.id===actual.id);assert.ok(bitmap,'Active background has a decoded translated PNG');
            assert.equal(bitmap.width,original.width);assert.equal(bitmap.height,original.height);
            const style=await backgroundReceiptStyle(original.attributes.style,bitmap.url);
            assert.deepEqual(actual,{...original,attributes:{...original.attributes,style}},'Background only borrows the exact image longhand; original URL pixels, child content and all other attributes remain unchanged');
        }else assert.deepEqual(actual,original,'Recovery leaves original pixels, dimensions and all source attributes unchanged');
    };
    const recoveryError=recoveryLongDetails?Array.from({length:80},(_,index)=>`Controlled text transport failure, diagnostic line ${index+1}: retry keeps the original manga artwork visible.`).join('\n'):'Controlled text transport failure for manga recovery';
    await modelObserver.command('Runtime.evaluate',{expression:`(()=>{
        const send=chrome.runtime.sendMessage.bind(chrome.runtime);
        const fixture=globalThis.__recoveryFixture={fail:true,failures:[]};
        chrome.runtime.sendMessage=(message,...args)=>{
            if(message?.type!=='fluentReadImageTranslateTexts'||!fixture.fail)return send(message,...args);
            fixture.failures.push({requestId:message.requestId,texts:message.texts});
            const response={success:false,error:${JSON.stringify(recoveryError)},errorCode:'failed'};
            const callback=args.at(-1);
            if(typeof callback==='function'){queueMicrotask(()=>callback(response));return;}
            return Promise.resolve(response);
        };
    })()`});
    const control=async selector=>recoveryUi(`const e=this.querySelector('.fr-image-feedback[data-phase="error"]:not([hidden]) ${selector}');if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,visible:!e.hidden&&r.width>0&&r.height>0&&s.visibility==='visible'&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),text:e.textContent};`);
    const click=async selector=>{const p=await control(selector);assert.ok(p?.visible,`Recovery control must be visible before trusted input: ${selector}`);await page.mouse.click(p.x,p.y);};
    const failed=()=>recoveryUi(`const f=this.querySelector('.fr-image-feedback[data-phase="error"]:not([hidden])');if(!f)return null;const r=f.getBoundingClientRect(),s=getComputedStyle(f);return {x:r.x,y:r.y,width:r.width,height:r.height,text:f.querySelector('.fr-image-status').textContent,pointerEvents:s.pointerEvents,style:f.style.cssText,computed:{font:s.font,boxSizing:s.boxSizing,maxWidth:s.maxWidth,maxHeight:s.maxHeight,overflow:s.overflow}};`);
    const boundsFor=index=>sourceFor(index).evaluate((element,{kind,index})=>{
        const rect=element.getBoundingClientRect(),scale=kind==='segments'?rect.height/element.naturalHeight:1;
        return {x:rect.x,y:rect.y+(kind==='segments'?(index-1)*2048*scale:0),width:rect.width,height:kind==='segments'?2048*scale:rect.height};
    },{kind,index});
    const position=async index=>{
        await sourceFor(index).evaluate((element,{kind,index})=>{
            const rect=element.getBoundingClientRect(),offset=kind==='segments'?(index-1)*2048*rect.height/element.naturalHeight:0;
            scrollTo({top:rect.top+scrollY+offset-40,behavior:'instant'});
        },{kind,index});
        await wait(async()=>!!await failed(),90000,true);
        const m=await failed(),bounds=await boundsFor(index),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
        // 在断言前保存，布局失败也能从完整位置和样式定位，而不是只留下 assertion 字符串。
        (report.recoveryMetrics??=[]).push({page:index,surface:kind,...m,sourceBounds:bounds,viewport});
        assert.ok(m.x>=bounds.x&&m.x+m.width<=bounds.x+bounds.width+1&&m.y>=Math.max(0,bounds.y)&&m.y+m.height<=Math.min(viewport.height,bounds.y+bounds.height),'Recovery stays inside the visible source page');
        assert.ok(m.height<180&&m.width<=360,'Recovery uses a compact edge surface');
        assert.equal(m.pointerEvents,'auto');assert.equal(await sourceFor(index).evaluate(i=>i.style.opacity==='0'),false,'Failure keeps original artwork visible');
        assert.ok((await control('.fluent-read-image-translation-button'))?.visible);assert.ok((await control('.fr-image-dismiss'))?.visible);
        await unchanged(index);
    };
    const visibleBitmaps=()=>kind==='background'?backgroundPresentations(originalBackgrounds):recoveryUi(`return [...this.querySelectorAll(${JSON.stringify(kind==='image'?'.fluent-read-image-translation-bitmap':'canvas')})].filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&getComputedStyle(e).display!=='none'&&r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0}).map(e=>({width:e.width||e.naturalWidth,height:e.height||e.naturalHeight,data:e.tagName==='CANVAS'?e.toDataURL('image/png'):e.src}));`);
    const completed=async()=>kind==='image'?await sourceFor(1).evaluate(i=>i.style.opacity==='0'):(await visibleBitmaps())?.length>0;
    const quiet=async()=>{await assertQuietReading();assert.notEqual(await recoveryUi(`return [...this.querySelectorAll('.fr-image-feedback')].some(e=>!e.hidden&&e.getBoundingClientRect().width>0)`),true,'Successful surface removes all failure prompts');};
    report.currentCase='failed manga page exposes visible single-page recovery without automatic retry';
    await toggle();await position(1);
    const failedCount=await ops();await page.waitForTimeout(300);assert.equal(await ops(),failedCount);
    await screenshot('recovery-error-visible');report.cases.push(report.currentCase);
    report.currentCase='error details accept trusted keyboard input without reaching reader shortcuts';
    await page.evaluate(()=>{globalThis.__recoveryHostKeys=0;document.addEventListener('keydown',()=>globalThis.__recoveryHostKeys++);});
    await recoveryUi(`this.querySelector('.fr-image-feedback[data-phase="error"] summary').focus()`);
    await page.keyboard.press('Enter');
    assert.equal(await recoveryUi(`return this.querySelector('.fr-image-feedback[data-phase="error"] details').open`),true);
    assert.equal(await page.evaluate(()=>globalThis.__recoveryHostKeys),0);
    if(recoveryLongDetails){
        const layout=()=>recoveryUi(`const f=this.querySelector('.fr-image-feedback[data-phase="error"]'),d=f.querySelector('details'),a=f.querySelector('.fr-image-actions');const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {feedback:rect(f),actions:rect(a),details:rect(d),errorText:d.querySelector('p').textContent,direction:getComputedStyle(f).direction,documentDirection:document.documentElement.dir,viewport:{width:innerWidth,height:innerHeight},scrollTop:d.scrollTop,scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,pageScroll:scrollY,actionsBeforeDetails:!!(a.compareDocumentPosition(d)&Node.DOCUMENT_POSITION_FOLLOWING),buttons:[...a.querySelectorAll('button')].map(e=>({className:e.className,hidden:e.hidden,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),centerHit:this.elementFromPoint(...(()=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})())===e,...rect(e)}))};`);
        const before=await layout();report.recoveryLongDetails={before};
        assert.equal(before.actionsBeforeDetails,true,'Recovery actions precede diagnostic details in DOM and tab order');
        assert.equal(before.errorText,recoveryError,'All 80 diagnostic lines remain available without truncation');
        assert.deepEqual(before.viewport,report.recoveryEnvironment.viewport,'Recovery CSS viewport remains stable through trusted keyboard input');
        if(recoveryRtl){assert.equal(before.documentDirection,'rtl');assert.equal(before.direction,'rtl','Feedback actually renders the RTL host direction');}
        assert.ok(before.scrollHeight>before.clientHeight,'Long diagnostics have their own scrollable area');
        const viewport=report.recoveryEnvironment.viewport;
        for(const className of ['fluent-read-image-translation-button','fr-image-dismiss'])assert.ok(before.buttons.some(button=>button.className===className&&button.visible&&button.centerHit),'Required retry and dismiss actions are visible and hit-testable');
        for(const button of before.buttons.filter(button=>!button.hidden))assert.ok(button.visible&&button.centerHit&&button.x>=before.feedback.x&&button.right<=before.feedback.right+1&&button.y>=before.feedback.y&&button.bottom<=before.feedback.bottom+1&&button.x>=0&&button.right<=viewport.width+1&&button.y>=0&&button.bottom<=viewport.height+1,'Every recovery action stays fully visible and hit-testable with diagnostics open');
        await page.mouse.move(before.details.x+before.details.width/2,before.details.y+before.details.height/2);await page.mouse.wheel(0,400);
        await wait(async()=>(await layout()).scrollTop>0,10000,true);
        const after=await layout();report.recoveryLongDetails.after=after;
        assert.deepEqual(after.actions,before.actions,'Scrolling diagnostics does not move recovery actions');assert.equal(after.pageScroll,before.pageScroll,'Diagnostic scrolling does not scroll the reader');
        await recoveryUi(`this.querySelector('.fr-image-feedback[data-phase="error"] summary').focus({preventScroll:true})`);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await recoveryUi(`return !!this.activeElement?.closest('.fr-image-actions')`),true,'Backward tab reaches a recovery action before details');
        await page.keyboard.press('Tab');
        assert.equal(await recoveryUi(`return this.activeElement?.tagName`),'SUMMARY');
        assert.equal(await page.evaluate(()=>globalThis.__recoveryHostKeys),0,'Diagnostic keyboard input remains isolated from reader shortcuts');
    }
    await screenshot('recovery-keyboard-details');if(!recoveryLongDetails)await page.keyboard.press('Enter');report.cases.push(report.currentCase);
    report.currentCase='trusted retry recovers only this page and removes error actions while loading';
    await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__recoveryFixture.fail=false'});
    await click('.fluent-read-image-translation-button');
    await wait(async()=>await ops()===failedCount+1,10000);
    assert.equal(await failed(),null);
    assert.notEqual(await recoveryUi(`return [...this.querySelectorAll('.fr-image-feedback[data-phase="loading"] .fr-image-actions')].some(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0)`),true);
    await wait(completed);
    assert.equal(await ops(),failedCount+1);await unchanged(1,true);await quiet();await screenshot('recovery-retry-complete');report.cases.push(report.currentCase);
    if(recoveryCanvasAlpha){
        report.recoveryCanvasAlpha.presentation=await sourceFor(1).evaluate(element=>{const rect=element.getBoundingClientRect();return {bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},opacity:element.style.getPropertyValue('opacity'),opacityPriority:element.style.getPropertyPriority('opacity'),transitionProperty:element.style.getPropertyValue('transition-property'),transitionPriority:element.style.getPropertyPriority('transition-property'),background:getComputedStyle(document.body).backgroundColor,dpr:devicePixelRatio};});
        const {opacity,opacityPriority,transitionProperty,transitionPriority}=report.recoveryCanvasAlpha.presentation;
        assert.deepEqual({opacity,opacityPriority,transitionProperty,transitionPriority},{opacity:'0',opacityPriority:'important',transitionProperty:'none',transitionPriority:'important'},'The transparent source is hidden only by the two explicitly owned properties');
        const translated=await visibleBitmaps();assert.equal(translated.length,1);
        fs.writeFileSync(path.join(artifacts,'recovery-alpha-translated.png'),Buffer.from(translated[0].data.split(',')[1],'base64'));
        report.recoveryCanvasAlpha.translated='recovery-alpha-translated.png';report.recoveryCanvasAlpha.screenshot='recovery-retry-complete.png';
    }
    if(recoveryBackgroundAlpha){
        const describe=()=>sourceFor(1).evaluate(element=>{
            const rect=element.getBoundingClientRect(),style=getComputedStyle(element),box=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
            const children=[...element.querySelectorAll('#recovery-host-caption,#recovery-host-action')].map(child=>{const bounds=child.getBoundingClientRect(),computed=getComputedStyle(child),hit=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);return {id:child.id,rect:box(bounds),background:computed.backgroundColor,color:computed.color,opacity:computed.opacity,hit:hit===child||child.contains(hit),text:child.textContent};});
            return {bounds:box(rect),dpr:devicePixelRatio,background:style.backgroundColor,pageBackground:getComputedStyle(document.body).backgroundColor,backgroundImage:style.backgroundImage,imagePriority:element.style.getPropertyPriority('background-image'),children};
        });
        const presentation=await describe();report.recoveryBackgroundAlpha.presentation=presentation;
        assert.equal(presentation.background,'rgb(29, 65, 83)');assert.equal(presentation.imagePriority,'important');assert.equal(presentation.children.length,2);
        const region=report.recoveryBackgroundAlpha.wordlessChildRegion;
        for(const child of presentation.children){
            const x=(child.rect.x-presentation.bounds.x)*900/presentation.bounds.width,y=(child.rect.y-presentation.bounds.y)*900/presentation.bounds.height;
            const width=child.rect.width*900/presentation.bounds.width,height=child.rect.height*900/presentation.bounds.height;
            assert.ok(x>=region.x0&&y>=region.y0&&x+width<=region.x1&&y+height<=region.y1,'Host controls remain entirely inside the independently frozen wordless artwork region');
        }
        assert.equal((await recoveryUi('return this.querySelectorAll("canvas").length'))??0,0,'No fixed translated Canvas paints above the original host children');
        const translated=await visibleBitmaps();assert.equal(translated.length,1);assert.equal(translated[0].width,900);assert.equal(translated[0].height,900);
        fs.writeFileSync(path.join(artifacts,'recovery-background-alpha-translated.png'),Buffer.from(translated[0].data.split(',')[1],'base64'));
        report.recoveryBackgroundAlpha.translated='recovery-background-alpha-translated.png';report.recoveryBackgroundAlpha.screenshot='recovery-retry-complete.png';report.recoveryBackgroundAlpha.translatedUrl=translated[0].url;
        report.currentCase='background translation preserves visible host children and trusted clicks reach the original host';
        const button=page.locator('#recovery-host-action');await button.scrollIntoViewIfNeeded();
        const interactive=await describe();report.recoveryBackgroundAlpha.interaction=interactive;
        assert.ok(interactive.children.every(child=>child.hit&&child.opacity==='1'),'Host foreground children remain hit-testable above the CSS background');
        const clicksBefore=await page.evaluate(()=>globalThis.__recoveryHostClicks.length),point=await button.boundingBox();assert.ok(point&&point.width>0&&point.height>0);
        await page.mouse.click(point.x+point.width/2,point.y+point.height/2);
        const clicks=await page.evaluate(()=>globalThis.__recoveryHostClicks);assert.equal(clicks.length,clicksBefore+1);assert.deepEqual(clicks.at(-1),{trusted:true,target:'recovery-host-action'});report.recoveryBackgroundAlpha.hostClicks=clicks;
        await unchanged(1,true);assert.equal(await ops(),failedCount+1);await screenshot('recovery-background-host-content');report.cases.push(report.currentCase);
        await sourceFor(1).evaluate(element=>scrollTo({top:element.getBoundingClientRect().top+scrollY-40,behavior:'instant'}));
    }
    report.currentCase='recovered manga redisplays the cached translation without OCR';
    const completedCount=await ops(),bitmapsBefore=await visibleBitmaps();assert.ok(bitmapsBefore?.length>0,'Recovered source has a visible translated bitmap');
    await toggle();await wait(async()=>(await visibleBitmaps())?.length===0);await unchanged(1);
    await toggle();await wait(completed);assert.equal(await ops(),completedCount);
    assert.deepEqual(await visibleBitmaps(),bitmapsBefore,'Cached redisplay preserves exact translated pixels');await unchanged(1,true);report.cases.push(report.currentCase);
    if(recoveryCanvasAlpha){
        report.currentCase='real CSSOM preserves a host transition-duration change when the source visibility receipt is returned';
        // 预期只从事先快照和明确的宿主改写构造，不用被测结果反推或放宽样式归还断言。
        const plannedStyle=await page.evaluate(raw=>{const style=document.createElement('canvas').style;style.cssText=raw||'';style.setProperty('transition-duration','2s');const restored=style.cssText;style.setProperty('transition-property','none','important');style.setProperty('opacity','0','important');return {restored,leased:style.cssText};},originals[0].attributes.style);
        await sourceFor(1).evaluate(element=>element.style.setProperty('transition-duration','2s'));
        expectedOriginals[0].attributes.style=plannedStyle.restored;leasedStyles[0]=plannedStyle.leased;
        await toggle();await wait(async()=>(await visibleBitmaps())?.length===0);await unchanged(1);
        report.recoveryCanvasAlpha.hostTransitionAfterRestore=await snapshot(sourceFor(1));
        await toggle();await wait(completed);assert.equal(await ops(),completedCount);await unchanged(1,true);
        assert.deepEqual(await visibleBitmaps(),bitmapsBefore,'Host CSS changes do not rerun OCR or alter cached translated pixels');report.cases.push(report.currentCase);
    }
    report.currentCase='dismissing a later failed page removes its prompt without retrying it';
    await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__recoveryFixture.fail=true'});
    await position(2);const beforeDismiss=await ops();await click('.fr-image-dismiss');
    assert.equal(await failed(),null);await page.waitForTimeout(300);assert.equal(await ops(),beforeDismiss);await unchanged(2);report.cases.push(report.currentCase);
    report.currentCase='pausing continuous translation clears a failed page and its controls';
    await position(3);await toggle();
    await wait(async()=>await failed()===null,10000,true);
    if(kind==='background')assert.equal((await visibleBitmaps()).length,0);else assert.equal(await recoveryUi(`return this.querySelectorAll(${JSON.stringify(kind==='image'?'.fluent-read-image-translation-bitmap':'canvas')}).length`),0);
    for(let index=1;index<=3;index++)await unchanged(index);
    const injected=await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__recoveryFixture.failures',returnByValue:true});
    report.recoveryFailures=injected.result.value;
    assert.equal(report.recoveryFailures.length,3);assert.ok(report.recoveryFailures.every(item=>item.texts.some(text=>text.trim())),'Every injected failure follows actual successful OCR');
    report.cases.push(report.currentCase);auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);focusGuard();
}
async function verifyPageFeedback() {
    const first=page.locator('#page-one'),second=page.locator('#page-two');
    const scroll=async image=>{await image.evaluate(i=>scrollTo({top:i.getBoundingClientRect().top+scrollY-40,behavior:'instant'}));await page.waitForTimeout(100);};
    const point=()=>ball(`const r=this.querySelector('.floating-ball-manga').getBoundingClientRect();return {x:r.x+r.width/4,y:r.y+r.height/2}`);
    await patch({floatingBallToolsDisplay:'hover'});
    report.currentCase='explicit hover preference retracts compact comic controls and expands on hover';
    const initial=await ball(`const b=this.querySelector('.floating-ball-manga'),r=b.getBoundingClientRect();return {width:r.width,visible:r.width/2,inset:innerWidth-r.right+r.width/2,icon:b.querySelector('svg').innerHTML}`);
    assert.equal(initial.width,32);assert.ok(initial.visible>8&&initial.visible<=18);assert.ok(initial.inset>=16);assert.ok(!initial.icon.includes('<rect'));
    let p=await point();await page.mouse.move(p.x,p.y);await page.waitForTimeout(600);
    assert.equal(await ball('return this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),true);
    await page.waitForTimeout(2800);assert.equal(await ball('return this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),false);
    report.cases.push(report.currentCase);await screenshot('manga-entry-retracted');
    report.currentCase='processing feedback belongs to the current image and shows stage without a cancel popup';
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await toggle();
    await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    const metrics=await imageUi(`const f=[...this.querySelectorAll('.fr-image-feedback')].find(e=>!e.hidden),r=f.getBoundingClientRect();return {text:f.textContent,width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2,pointerEvents:getComputedStyle(f).pointerEvents,buttons:f.querySelectorAll('button').length}`);
    const bounds=await first.boundingBox();assert.ok(metrics.width<230&&metrics.height<40);assert.equal(metrics.pointerEvents,'none');assert.equal(metrics.buttons,0);
    assert.ok(metrics.x>bounds.x&&metrics.x<bounds.x+bounds.width&&metrics.y>bounds.y&&metrics.y<bounds.y+bounds.height);assert.match(metrics.text,/翻译文字/);
    report.feedbackMetrics=metrics;await assertQuietReading();report.cases.push(report.currentCase);await screenshot('manga-stage-feedback');
    report.currentCase='owned stage progress displays a true value supplied by transport, no estimated overall percent';
    const requestId=await worker.evaluate(()=>globalThis.__mangaTest.operations.at(-1));
    await modelObserver.command('Runtime.evaluate',{expression:`chrome.runtime.sendMessage({type:'fluentReadImageProgress',requestId:${JSON.stringify(requestId)},stage:'recognizing',progress:45})`,awaitPromise:true});
    await wait(async()=>await imageUi(`return this.querySelector('.fr-image-feedback:not([hidden]) [role=progressbar]')?.getAttribute('aria-valuenow')==='45'`),10000);
    report.progressFixture={stage:'recognizing',progress:45,source:'controlled owned Offscreen message; display contract, not an OCR benchmark'};
    await screenshot('manga-recognition-progress');report.cases.push(report.currentCase);
    report.currentCase='changing interface language preserves the real progress value and localizes its stage';
    await patch({uiLanguage:'en-US'});await wait(async()=>await imageUi(`return /Recogniz/i.test(this.querySelector('.fr-image-feedback:not([hidden]) .fr-image-status')?.textContent || '')`),10000);
    assert.equal(await imageUi(`return this.querySelector('.fr-image-feedback:not([hidden]) [role=progressbar]')?.getAttribute('aria-valuenow')`),'45');await screenshot('manga-progress-english');
    await patch({uiLanguage:'zh-CN'});report.cases.push(report.currentCase);
    await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld();});await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
    report.currentCase='finished page has neither processing feedback nor lower-left controls';
    assert.equal(await imageUi(`return [...this.querySelectorAll('.fr-image-feedback')].some(e=>!e.hidden)`),false);await assertQuietReading();report.cases.push(report.currentCase);
    report.currentCase='returning to the first translated image while the next page processes preserves its display';
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await scroll(second);
    await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);const before=await ops();await scroll(first);
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'),10000);
    const reversions=await first.evaluate(async i=>{const bad=[];for(let n=0;n<45;n++){await new Promise(requestAnimationFrame);if(i.style.opacity!=='0')bad.push(n);}return bad;});
    assert.deepEqual(reversions,[]);assert.equal(await ops(),before);report.cases.push(report.currentCase);
    report.currentCase='repeated original and translation switches restore immediately without recognizing the first page again';
    for(let n=0;n<3;n++){await toggle();await wait(async()=>await first.evaluate(i=>i.style.opacity!=='0'),10000);await toggle();await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'),10000);}
    assert.equal(await ops(),before,'Original/translation comparisons do not send more recognition requests');
    await assertQuietReading();report.cases.push(report.currentCase);await screenshot('manga-return-preserved');
    await toggle();await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld?.();});await page.waitForTimeout(500);
    report.currentCase='keyboard focus keeps controls expanded until Escape';
    await page.mouse.click(30,30);await page.keyboard.press('Tab');await page.waitForTimeout(3000);
    assert.equal(await ball('return this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),true);
    await page.keyboard.press('Escape');await wait(async()=>await ball('return !this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),10000);report.cases.push(report.currentCase);
    report.currentCase='prefetch evicts the first fast-cache slot without removing its active translated surface';
    await patch({imageTranslationMangaPrefetchPages:3,imageTranslationMangaCachePages:1});await page.reload({waitUntil:'domcontentloaded'});
    await wait(async()=>!!await ball('return this.querySelector(".floating-ball-manga")'),10000);await scroll(first);
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await toggle();await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;globalThis.__mangaTest.releaseHeld();});
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0')&&await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;globalThis.__mangaTest.releaseHeld();});
    await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    const afterPrefetch=await first.evaluate(async i=>{const bad=[];for(let n=0;n<60;n++){await new Promise(requestAnimationFrame);if(i.style.opacity!=='0')bad.push(n);}return bad;});
    assert.deepEqual(afterPrefetch,[]);await assertQuietReading();report.cases.push(report.currentCase);await screenshot('manga-prefetch-keeps-current');
    await toggle();await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld?.();});await page.waitForTimeout(300);
    report.currentCase='standalone entry uses the same compact icon and idle retraction';
    await patch({disableFloatingBall:true,imageTranslationMangaPromptEnabled:true});await wait(async()=>!!await mangaEntry('return this.querySelector(".fr-manga-launcher")'),10000);
    let standalone=await mangaEntry('const r=this.querySelector(".fr-manga-launcher").getBoundingClientRect();return {width:r.width,visible:r.width/2,x:r.x+r.width/4,y:r.y+r.height/2}');
    assert.equal(standalone.width,32);assert.ok(standalone.visible<=18);await page.mouse.move(standalone.x,standalone.y);await page.waitForTimeout(500);
    assert.equal(await mangaEntry('return this.querySelector(".fr-manga-launcher").classList.contains("is-expanded")'),true);
    await page.waitForTimeout(2800);assert.equal(await mangaEntry('return this.querySelector(".fr-manga-launcher").classList.contains("is-expanded")'),false);
    report.cases.push(report.currentCase);await screenshot('manga-standalone-retracted');
    report.currentCase='standalone keyboard focus remains available and Escape retracts within closed Shadow DOM';
    await page.mouse.click(30,30);await page.keyboard.press('Tab');await page.waitForTimeout(2800);
    assert.equal(await mangaEntry('return this.querySelector(".fr-manga-launcher").matches(":focus-visible")'),true);
    await page.keyboard.press('Escape');await wait(async()=>await mangaEntry('return !this.querySelector(".fr-manga-launcher").classList.contains("is-expanded")'),10000);report.cases.push(report.currentCase);
    report.currentCase='ordinary image uses the selected PaddleOCR with shared models and its lightweight controls';
    await patch({imageTranslationMangaEnabled:false,imageTranslationOcrEngine:'paddle',imageTranslationHoverEnabled:true,disableFloatingBall:true,useCache:false});
    await page.reload({waitUntil:'domcontentloaded'});await scroll(first);
    await first.evaluate(i=>{i.style.width='500px';i.style.height='auto';i.parentElement.style.width='500px';});
    const languageStatus=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadImageOcrStatus'}));
    assert.deepEqual(languageStatus.languages,[],'No Tesseract language pack exists in this isolated profile');
    const ordinaryBefore=await ops(),originalBounds=await first.boundingBox();
    await page.mouse.move(originalBounds.x+originalBounds.width/2,originalBounds.y+100);
    await wait(async()=>await imageUi(`return [...this.querySelectorAll('.fr-image-controls:not([hidden]) button')].some(b=>b.getBoundingClientRect().width>0)`),10000);
    const ordinaryButton=await imageUi(`const b=this.querySelector('.fr-image-controls:not([hidden]) button'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await page.mouse.click(ordinaryButton.x,ordinaryButton.y);
    await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    const ordinaryFeedback=await imageUi(`const f=this.querySelector('.fr-image-feedback:not([hidden])'),s=getComputedStyle(f);return {manga:f.dataset.manga,font:s.fontSize,height:f.getBoundingClientRect().height,buttons:f.querySelectorAll('button').length}`);
    assert.notEqual(ordinaryFeedback.manga,'true');assert.equal(ordinaryFeedback.font,'11px');assert.ok(ordinaryFeedback.height<40);assert.equal(ordinaryFeedback.buttons,0);
    await worker.evaluate(()=>globalThis.__mangaTest.releaseHeld());await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'),90000);
    assert.equal(await ops(),ordinaryBefore+1);assert.equal(await imageUi(`return [...this.querySelectorAll('.fr-image-controls:not([hidden])')].some(e=>getComputedStyle(e).display!=='none')`),true);
    assert.deepEqual((await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadImageOcrStatus'}))).languages,[]);
    report.ordinaryPaddle={...ordinaryFeedback,tesseractPacks:0,source:'real shared PaddleOCR models; deterministic text translation transport'};
    report.cases.push(report.currentCase);await screenshot('ordinary-image-paddle');
    const preview=arg('controls-preview-bundle',null);
    if(preview){
        report.currentCase='ordinary image UI restores the lightweight historical status, with cancel outside the central indicator';
        await page.addScriptTag({path:path.resolve(preview)});
        const common=await page.evaluate(()=>{
            document.querySelector('#reader').replaceChildren();
            const host=document.createElement('div');host.style.cssText='position:fixed;left:260px;top:220px;width:760px;height:400px;background:#e9f0f7;';
            const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');style.textContent=FluentReadControlsPreview.IMAGE_CONTROLS_CSS;
            const chart=document.createElement('canvas');chart.width=760;chart.height=400;chart.style.width='100%';
            const c=chart.getContext('2d');c.fillStyle='#e9f0f7';c.fillRect(0,0,760,400);c.strokeStyle='#2861bb';c.lineWidth=3;c.beginPath();c.moveTo(20,310);c.lineTo(180,230);c.lineTo(390,170);c.lineTo(560,135);c.lineTo(720,105);c.stroke();c.fillStyle='#1d8582';c.font='bold 24px Arial';c.fillText('2.67×',280,100);c.fillText('2.85×',560,220);c.fillStyle='#263244';c.font='18px Arial';c.fillText('Read the image while processing',230,340);
            let controls;controls=FluentReadControlsPreview.createImageControls({onAction(){controls.update('idle','翻译图片');},onPrepare(){}});
            controls.update('loading','正在识别图片文字…',{progress:45});shadow.append(style,chart,controls.feedback,controls.element);document.body.append(host);
            globalThis.__controlsPreview={host,controls};
            const r=controls.feedback.getBoundingClientRect(),s=getComputedStyle(controls.feedback);
            return {height:r.height,width:r.width,font:s.fontSize,padding:s.padding,background:s.backgroundColor,pointerEvents:s.pointerEvents,centralButtons:controls.feedback.querySelectorAll('button').length,cancelOwner:controls.button.parentElement.parentElement.className};
        });
        assert.ok(common.height<40);assert.equal(common.font,'11px');assert.equal(common.centralButtons,0);assert.equal(common.cancelOwner,'fr-image-controls');assert.equal(common.pointerEvents,'none');
        report.ordinaryImagePreview={...common,source:'current production controls module, controlled UI state; actual image runtime covered by unit tests'};
        await screenshot('ordinary-image-ui-restored');
        const cancelPoint=await page.evaluate(()=>{const r=globalThis.__controlsPreview.controls.button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});await page.mouse.click(cancelPoint.x,cancelPoint.y);
        assert.equal(await page.evaluate(()=>globalThis.__controlsPreview.controls.feedback.hidden),true);
        report.cases.push(report.currentCase);await page.evaluate(()=>{globalThis.__controlsPreview.controls.dispose();globalThis.__controlsPreview.host.remove();delete globalThis.__controlsPreview;});
    }
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}

function auditPageErrors() {
    // Only paired CDP exceptions in the default page context establish a host error; unknown errors still fail.
    report.errors=report.pageErrors.filter((error,errorIndex)=>{
        if(report.hostErrors.some(host=>host.errorIndex===errorIndex || (error.stack && host.stack===error.stack)))return false;
        let exception=error.stack ? report.scriptExceptions?.find(event=>event.details.exception?.description===error.stack) : undefined;
        if(!error.stack){
            const errors=report.pageErrors.filter(item=>!item.stack && item.message===error.message);
            const exceptions=(report.scriptExceptions||[]).filter(event=>event.details.exception?.description===error.message);
            // Preserve event order and require equal counts, so a generic "Object" cannot mask an unknown/extension error.
            if(errors.length===exceptions.length)exception=exceptions[errors.indexOf(error)];
        }
        if(liveSite&&!error.stack.includes('chrome-extension://')&&exception?.context?.auxData?.isDefault===true) {
            report.hostErrors.push({...error,errorIndex,context:exception.context,cdpExceptionId:exception.details.exceptionId});return false;
        }
        return true;
    }).map(error=>error.message);
}

async function verifyPipelinePerformance(extensionId) {
    assert.ok(Number.isInteger(pipelineRounds)&&pipelineRounds>=(qualityManifest?1:2)&&pipelineRounds<=5,qualityManifest?'Quality scenes allow 1–5 bounded rounds':'Measure first use separately from bounded warm runs');
    await patch({animations:false});
    const chunks=fs.readdirSync(path.join(extensionDir,'chunks'));
    const ortFiles=chunks.filter(name=>/^ort\.(?:webgpu\.)?(?:bundle\.)?min-/.test(name));
    assert.ok(ortFiles.length || fs.existsSync(path.join(extensionDir,'mangaInferenceWorker.js')),'Production ORT namespace or isolated inference Worker exists');
    report.pipelineInstrumentationScope=ortFiles.length?'Offscreen inference':'Offscreen rendering; inference executes in a separate Worker';
    // 只在自有临时扩展 Offscreen 中测量；不改变宿主页或普通生产代码。
    await modelObserver.command('Runtime.evaluate',{expression:`(async()=>{
        if(${forceCpu})Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
        const samples=globalThis.__pipelineSamples={sessions:[],runs:[],encodes:[],reads:[],canvasCalls:{},yields:[],gpuSubmissions:0,adapters:[],userAgent:navigator.userAgent};
        samples.workers=[];
        const NativeWorker=globalThis.Worker;
        globalThis.Worker=class extends NativeWorker {
            constructor(...args){super(...args);this.addEventListener('message',event=>{if(event.data?.diagnostics)globalThis.__pipelineSamples.workers.push(event.data.diagnostics);});}
        };
        const read=FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL=function(blob){const start=Date.now();this.addEventListener('loadend',()=>samples.reads.push({start,end:Date.now(),bytes:blob.size}),{once:true});return read.call(this,blob);};
        const schedule=globalThis.setTimeout;
        globalThis.setTimeout=function(callback,delay,...args){if(delay!==0)return schedule(callback,delay,...args);const start=performance.now();return schedule(()=>{samples.yields.push(performance.now()-start);callback(...args);},delay);};
        for(const name of ['measureText','getImageData','putImageData','drawImage','fillText','strokeText']) {
            const original=CanvasRenderingContext2D.prototype[name];
            CanvasRenderingContext2D.prototype[name]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{const entry=samples.canvasCalls[name]??={count:0,ms:0};entry.count++;entry.ms+=performance.now()-start;}};
        }
        if(globalThis.GPUQueue){const submit=GPUQueue.prototype.submit;GPUQueue.prototype.submit=function(...args){samples.gpuSubmissions++;return submit.apply(this,args);};}
        if(navigator.gpu){const request=navigator.gpu.requestAdapter.bind(navigator.gpu);navigator.gpu.requestAdapter=async(...args)=>{const start=performance.now();const adapter=await request(...args);samples.adapters.push({ms:performance.now()-start,available:!!adapter,fallback:adapter?.isFallbackAdapter,info:adapter?.info&&{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}});return adapter;};}
        const constructors=new Set();
        for(const file of ${JSON.stringify(ortFiles)}) {
            const module=await import(chrome.runtime.getURL('chunks/'+file));
            const ort=Object.values(module).find(value=>value?.InferenceSession);
            if(!ort || constructors.has(ort.InferenceSession))continue;constructors.add(ort.InferenceSession);
            const create=ort.InferenceSession.create.bind(ort.InferenceSession);
            if(${gpuDiagnosis} && file.includes('webgpu')) {
                try {
                    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths={mjs:chrome.runtime.getURL('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'),wasm:chrome.runtime.getURL('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm')};
                    const cache=await caches.open('fluent-read-manga-ocr-v1'),keys=await cache.keys();
                    const key=keys.find(key=>key.url.includes('small_det'));
                    const model=await(await cache.match(key)).arrayBuffer();
                    const session=await create(model,{executionProviders:['webgpu']});await session.release();samples.gpuDiagnosis='success';
                } catch(error){samples.gpuDiagnosis=String(error);}
            }
            ort.InferenceSession.create=async(model,options)=>{
                const start=performance.now();const session=await create(model,{...options,${graphOverride?`graphOptimizationLevel:${JSON.stringify(graphOverride)}`:''}});
                const kind=session.inputNames.includes('mask')?'inpaint':'ocr';
                samples.sessions.push({kind,ms:performance.now()-start,providers:options?.executionProviders});
                const run=session.run.bind(session);
                session.run=async(...args)=>{const start=performance.now();const result=await run(...args);samples.runs.push({kind,ms:performance.now()-start,inputs:Object.fromEntries(Object.entries(args[0]).map(([name,tensor])=>[name,tensor.dims]))});return result;};
                return session;
            };
        }
        const encode=HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL=function(...args){const start=performance.now();const value=encode.apply(this,args);samples.encodes.push({width:this.width,height:this.height,ms:performance.now()-start,bytes:value.length,method:'toDataURL'});return value;};
        const toBlob=HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob=function(callback,...args){const start=performance.now(),width=this.width,height=this.height;return toBlob.call(this,blob=>{samples.encodes.push({width,height,ms:performance.now()-start,bytes:blob?.size,method:'toBlob'});callback(blob);},...args);};
        samples.gpu=navigator.gpu?await navigator.gpu.requestAdapter({powerPreference:'high-performance'}).then(adapter=>({available:!!adapter,info:adapter?.info&&{vendor:adapter.info.vendor,architecture:adapter.info.architecture}})):null;
    })()`,awaitPromise:true,returnByValue:true});
    report.pipeline=[];report.graphOverride=graphOverride;
    for(const input of pipelineInputs) for(let round=0;round<pipelineRounds;round++) {
        const fixture=qualityFixtures?.find(fixture=>fixture.input===input);
        const caseName=fixture?.name||path.basename(input,'.png');
        report.currentCase=`${qualityManifest?'quality':'pipeline'} ${caseName} round ${round+1}`;
        if(fixture)await patch({from:fixture.sourceLanguage});
        await gotoVisible(page,targetUrl,{waitUntil:'domcontentloaded'});
        const data='data:image/png;base64,'+fs.readFileSync(input).toString('base64');
        await page.evaluate(async data=>{
            const images=[...document.querySelectorAll('.zao-image')];images.slice(1).forEach(image=>image.parentElement.remove());
            const image=images[0];image.src=data;await image.decode();window.scrollTo(0,0);
        },data);
        if(fixture)await page.locator('.zao-image').first().evaluate(image=>image.style.height='auto');
        const sourceState=await page.locator('.zao-image').first().evaluate(image=>({src:image.src,srcset:image.getAttribute('srcset'),sizes:image.getAttribute('sizes'),style:image.getAttribute('style')}));
        const batchStart=await worker.evaluate(()=>globalThis.__mangaTest.textBatches.length);
        await page.evaluate(()=>{
            globalThis.__pipelineDisplay={changes:[]};
            const image=document.querySelector('.zao-image');
            new MutationObserver(()=>{const change={at:Date.now(),opacity:image.style.opacity};globalThis.__pipelineDisplay.changes.push(change);if(change.opacity==='0')requestAnimationFrame(()=>change.presentedAt=Date.now());}).observe(image,{attributes:true,attributeFilter:['style']});
        });
        if(ordinaryImageQuality)await page.mouse.move(10,10);
        else await wait(async()=>!!await ball(`return this.querySelector('.floating-ball-manga')`),30000);
        const before=await ops();const start=Date.now();
        await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__pipelineSamples.workers=[];globalThis.__pipelineSamples.runs=[];globalThis.__pipelineSamples.encodes=[];globalThis.__pipelineSamples.reads=[];globalThis.__pipelineSamples.sessions=[];globalThis.__pipelineSamples.canvasCalls={};globalThis.__pipelineSamples.yields=[];globalThis.__pipelineSamples.gpuSubmissions=0'});
        const measured=await require('./local-model-browser-helpers.cjs').measureBrowser(launched.context,`manga-round-${round+1}`,artifacts,async()=>{
            await toggle();
            await wait(async()=>await imageUi(`return !!this.querySelector('.fr-image-feedback:not([hidden]) .fr-image-spinner:not([hidden])')`),10000);
            report.loadingFrames??=[];
            const animation=await imageUi(`const feedback=this.querySelector('.fr-image-feedback:not([hidden])'),spinner=feedback.querySelector('.fr-image-spinner');const frames=[];for(let n=0;n<12;n++){await new Promise(resolve=>setTimeout(resolve,60));frames.push({at:performance.now(),transform:getComputedStyle(spinner).transform});}const r=feedback.getBoundingClientRect();return {frames,width:r.width,height:r.height,reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches,animated:spinner.dataset.animated};`);
            report.loadingFrames.push(animation);
            assert.ok(animation.height<40 && animation.width<280,'Status remains compact');
            if(!animation.reducedMotion)assert.ok(new Set(animation.frames.map(frame=>frame.transform)).size>1,'Spinner keeps rotating when decorative animations are disabled');
            assert.ok(animation.frames.every((frame,i,frames)=>!i || frame.at-frames[i-1].at<500),'Page heartbeat stays responsive during real inference');
            await screenshot(`${caseName}-loading-${round+1}`);
            if(fixture) {
                // 以真实响应决定是否保留原图：漏识别或只识别到无需改写的数字仍须完成全部质量统计。
                await wait(async()=>await worker.evaluate(index=>{
                    const id=globalThis.__mangaTest.operations[index];
                    return !!id&&globalThis.__mangaTest.layoutResults?.some(result=>result.requestId===id);
                },before)&&await imageUi(`return !!this.querySelector('.fr-image-feedback[data-phase="translated"]')`),180000);
            } else await wait(async()=>await page.locator('.zao-image').first().evaluate(i=>i.style.opacity==='0'),180000);
        });
        assert.equal(measured.error,undefined,'Measured pipeline completes');
        assert.equal(await page.locator('.zao-image').first().evaluate(i=>i.src),data,'Source stays the exact benchmark image');
        const end=Date.now();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
        const requestId=await worker.evaluate(index=>globalThis.__mangaTest.operations[index],before);
        const progress=await worker.evaluate(id=>globalThis.__mangaTest.progress.filter(p=>p.requestId===id),requestId);
        const textBatches=await worker.evaluate(index=>globalThis.__mangaTest.textBatches.slice(index),batchStart);
        const texts=textBatches.flat();
        const layout=fixture?await worker.evaluate(id=>globalThis.__mangaTest.layoutResults.find(result=>result.requestId===id),requestId):null;
        const observedNoBitmap=layout?.noBitmap===true;
        const sampled=await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__pipelineSamples',returnByValue:true});
        const displayedBitmap=await imageUi(`const surface=this.querySelector('.fluent-read-image-translation-bitmap');return surface?.tagName==='CANVAS'?surface.toDataURL('image/png'):surface?.src`);
        const assertOriginalWithoutBitmap=async(bitmap)=>{
            assert.ok(!bitmap,'A no-bitmap response leaves no translated surface');
            assert.deepEqual(await page.locator('.zao-image').first().evaluate(image=>({src:image.src,srcset:image.getAttribute('srcset'),sizes:image.getAttribute('sizes'),style:image.getAttribute('style')})),sourceState,'A no-bitmap response preserves the visible original source and styles');
            assert.equal(await page.locator('.zao-image').first().evaluate(image=>{const r=image.getBoundingClientRect(),s=getComputedStyle(image);return s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}),true,'The original remains visible in the viewport without a translated surface');
        };
        if(observedNoBitmap)await assertOriginalWithoutBitmap(displayedBitmap);
        const translated=displayedBitmap||(observedNoBitmap?data:undefined);
        assert.ok(translated?.startsWith('data:image/png;base64,'),'Lossless translated output exists');
        const output=path.join(artifacts,`${caseName}-round-${round+1}-translated.png`);
        fs.writeFileSync(output,Buffer.from(translated.split(',')[1],'base64'));
        const display=await page.evaluate(()=>globalThis.__pipelineDisplay);
        const result={input,scene:caseName,sourceLanguage:fixture?.sourceLanguage||sourceLanguage,round,cold:report.pipeline.length===0,totalMs:end-start,start,display,requestId,progress,texts,...sampled.result.value,output,resources:measured};
        report.pipeline.push(result);
        if(!fixture)assert.ok(texts.length>0,'Actual text recognition ran');
        if(fixture){
            result.expectedSource=fixture.expectedSource;
            assert.ok(layout,'Quality scene captures its actual offscreen OCR layout');result.ocrLines=layout.lines;result.observedNoBitmap=observedNoBitmap;
            // 正锚点、重复次数、负区域与无字页均保留失败，再完成后续场景；不以期望文字代替识别值。
            Object.assign(result,evaluateQualityFixture(fixture,{texts,lines:layout.lines}));
            if(fixture.expectedNoText) {
                result.wordlessPage={noTextTransport:texts.length===0,noBitmap:!displayedBitmap,sourcePreserved:JSON.stringify(await page.locator('.zao-image').first().evaluate(image=>({src:image.src,srcset:image.getAttribute('srcset'),sizes:image.getAttribute('sizes'),style:image.getAttribute('style')})))===JSON.stringify(sourceState)};
                if(!result.wordlessPage.noBitmap||!result.wordlessPage.sourcePreserved)result.qualityFailures.push({type:'wordless-page-render',reason:'A wordless source must remain visible without a translated bitmap',...result.wordlessPage});
            }
            const {qualityFailures:orderFailures,...order}=evaluateQualityReadingOrder(fixture,texts);
            Object.assign(result,order);result.qualityFailures.push(...orderFailures);
            result.protectedPixels=await page.evaluate(async({source,translated,probes})=>{
                const sample=async src=>{const image=new Image();image.src=src;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);return {width:canvas.width,height:canvas.height,pixels:probes.map(({x,y})=>Array.from(ctx.getImageData(x,y,1,1).data))};};
                return {source:await sample(source),translated:await sample(translated)};
            },{source:data,translated,probes:fixture.protectedProbes});
            assert.equal(result.protectedPixels.source.width,fixture.width);assert.equal(result.protectedPixels.source.height,fixture.height);
            assert.equal(result.protectedPixels.translated.width,fixture.width);assert.equal(result.protectedPixels.translated.height,fixture.height);
            for(let index=0;index<fixture.protectedProbes.length;index++){
                assert.deepEqual(result.protectedPixels.source.pixels[index].slice(0,3),fixture.protectedProbes[index].rgb,'Source probe agrees with reproducible fixture');
                assert.deepEqual(result.protectedPixels.translated.pixels[index],result.protectedPixels.source.pixels[index],`Protected artwork survives source mask repair: ${caseName} probe ${index}`);
            }
        }
        await assertQuietReading();
        await toggle();await wait(async()=>await page.locator('.zao-image').first().evaluate(i=>i.style.opacity!=='0'));
        if(fixture){
            assert.deepEqual(await page.locator('.zao-image').first().evaluate(image=>({src:image.src,srcset:image.getAttribute('srcset'),sizes:image.getAttribute('sizes'),style:image.getAttribute('style')})),sourceState,'Restoring original preserves source content and styles');
            const operations=await ops(),requests=await worker.evaluate(()=>globalThis.__mangaTest.requests.length);
            await toggle();await wait(async()=>observedNoBitmap?await imageUi(`return !!this.querySelector('.fr-image-feedback[data-phase="translated"]')`):await page.locator('.zao-image').first().evaluate(i=>i.style.opacity==='0'));
            const redisplayedBitmap=await imageUi(`const surface=this.querySelector('.fluent-read-image-translation-bitmap');return surface?.tagName==='CANVAS'?surface.toDataURL('image/png'):surface?.src`);
            if(observedNoBitmap)await assertOriginalWithoutBitmap(redisplayedBitmap);
            const restored=redisplayedBitmap||(observedNoBitmap?data:undefined);
            assert.equal(restored,translated,'Cached redisplay preserves exact translated bitmap');
            assert.equal(await ops(),operations,'Cached redisplay issues no OCR operation');
            assert.equal(await worker.evaluate(()=>globalThis.__mangaTest.requests.length),requests,'Cached redisplay issues no text transport');
            result.restoreAndRedisplay={sourcePreserved:true,bitmapPreserved:true,additionalOcrOperations:0,additionalTextRequests:0};
            await toggle();await wait(async()=>await page.locator('.zao-image').first().evaluate(i=>i.style.opacity!=='0'));
        }
        if(report.modelsPreloaded)assert.equal(report.modelRequests.length,report.modelRequestsAfterPreload,'Prepared models issue no new HTTP downloads during real inference');
        focusGuard();console.log(JSON.stringify({input:path.basename(input),scene:caseName,sourceLanguage:result.sourceLanguage,round,totalMs:end-start,runs:sampled.result.value.runs.length}));
    }
    report.cases.push(qualityManifest?'quality corpus with real production OCR, protected artwork pixels, original restore and cached redisplay':'same-source uncached pipeline runs with real production OCR and inpainting');
    if(qualityManifest){
        const anchors=report.pipeline.flatMap(result=>result.anchors||[]);
        const failures=report.pipeline.flatMap(result=>(result.qualityFailures||[]).map(failure=>({scene:result.scene,round:result.round,...failure})));
        report.qualitySummary={completedScenes:report.pipeline.length,expectedScenes:qualityFixtures.length*pipelineRounds,anchors:{total:anchors.length,matched:anchors.filter(anchor=>anchor.found).length,failed:anchors.filter(anchor=>!anchor.found).length},negativeRegions:{declared:qualityFixtures.reduce((sum,fixture)=>sum+(fixture.forbiddenRegions?.length||0),0)*pipelineRounds,falsePositives:report.pipeline.reduce((sum,result)=>sum+(result.negativeDetections?.length||0),0)},wordlessPages:report.pipeline.filter(result=>result.wordlessPage).map(result=>({scene:result.scene,...result.wordlessPage})),failures,
            normalization:'NFKC, uppercase, retain Unicode letters/numbers; count overlapping substring anchors in actual OCR text; exact occurrence counts follow manifest metadata or source-proven unique anchors',
            scope:'Exact OCR anchors, source occurrence counts, declared reading order, excess source-character counts and wordless artwork false positives are aggregated independently. Character inventories do not prove absence of omissions or preserve order. Protected pixels, source restoration, cached bitmap and request counts remain immediate structural assertions. No CER or translation-provider quality claim.'};
    }
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
    if(qualityManifest)assert.deepEqual(report.qualitySummary.failures,[],'All exact OCR quality anchors pass after completing every scene');
}

/** 仅此模式验证停留调度与初始化取消复用；真实模型推理，文字传输受控，不把返显时间当作 OCR 性能。 */
async function verifyScrollIntent() {
    assert.equal(liveSite,false,'Scroll intent uses the owned six-page fixture');
    assert.equal(prefetchPages,0,'Fast pass checks exclude intentionally configured prefetch');
    await page.setViewportSize({width:1280,height:700});
    const images=page.locator(readerSelector),first=images.first(),last=images.nth(4);
    await page.waitForFunction(()=>document.querySelectorAll('.zao-image').length===6 && [...document.querySelectorAll('.zao-image')].every(i=>i.complete&&i.naturalWidth));
    const readDiagnostics=async()=>{
        const result=await modelObserver.command('Runtime.evaluate',{expression:'JSON.stringify(globalThis.__mangaResidency)',returnByValue:true});
        return JSON.parse(result.result.value);
    };
    await toggle();
    // 已展开入口的坐标提前读取；普通 toggle helper 有 650 ms 悬停等待，不适合验证 180 ms 内暂停。
    const togglePoint=await ball(`const r=this.querySelector('.floating-ball-manga').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    const toggleNow=()=>page.mouse.click(togglePoint.x,togglePoint.y);
    if(process.argv.includes('--skip-initialization-cancel')) {
        await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
    } else {
        report.currentCase='pause during cold model initialization preserves one bounded warm worker for immediate resume';
        await wait(async()=>(await readDiagnostics()).events.at(-1)?.stage==='initializing',30000);
        report.pauseStage=(await readDiagnostics()).events.at(-1)?.stage;
        await toggleNow();
        assert.equal(await first.evaluate(i=>i.style.opacity==='0'),false,'Pause shows the original immediately');
        await page.waitForTimeout(100);
        await toggleNow();
        await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
        report.initializationResidency=await readDiagnostics();
        assert.equal(report.initializationResidency.created,1,'Resume shares the worker that was already initializing');
        assert.equal(report.initializationResidency.terminated,0,'Normal cancellation does not discard initialization');
        report.cases.push(report.currentCase);
    }
    await wait(async()=>await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'));
    const before=await ops();
    report.currentCase='rapidly passing three untranslated pages starts only the page where reading stops';
    report.passStart=Date.now();
    await images.evaluateAll(async items=>{
        for(const index of [1,2,3,4]) {
            items[index].scrollIntoView({block:'start',behavior:'instant'});
            await new Promise(resolve=>setTimeout(resolve,45));
        }
    });
    await wait(async()=>await last.evaluate(i=>i.style.opacity==='0'));
    await wait(async()=>await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy") === "false"'));
    report.fastPassOperations=(await ops())-before;
    assert.equal(report.fastPassOperations,1,'Only the settled fifth page issues OCR');
    assert.equal(await images.evaluateAll(items=>[1,2,3].every(index=>items[index].style.opacity!=='0')),true,'Passed pages retain their originals');
    report.cases.push(report.currentCase);await screenshot('settled-page-translated');
    report.currentCase='returning to a completed page displays its bitmap during the scroll gate without new OCR';
    report.cachedReturnMs=await first.evaluate(async i=>{
        const start=performance.now();i.scrollIntoView({block:'start',behavior:'instant'});
        for(let frame=0;frame<8;frame++) {await new Promise(requestAnimationFrame);if(i.style.opacity==='0')return performance.now()-start;}
        throw new Error('Cached page missed immediate frame handoff');
    });
    assert.ok(report.cachedReturnMs<180,'Cached display is not delayed until scroll settling');
    assert.equal(await ops(),before+1);report.cases.push(report.currentCase);
    report.currentCase='scrolling then pausing before settle cancels pending work and keeps every host image original';
    // 截图已把指针移开并收起入口，先完成真实悬停展开，再发出本次滚动与立即暂停。
    const exposed=await ball(`const b=this.querySelector('.floating-ball-manga'),r=b.getBoundingClientRect(),left=this.querySelector('.fr-floating-ball').dataset.position==='left';return {x:r.x+r.width*(left ? .75 : .25),y:r.y+r.height/2}`);
    await page.mouse.move(exposed.x,exposed.y);
    await wait(async()=>await ball('return this.querySelector(".fr-floating-ball").classList.contains("floating-ball-expanded")'),3000);
    await page.waitForTimeout(500);
    const pausePoint=await ball(`const r=this.querySelector('.floating-ball-manga').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    await page.mouse.move(pausePoint.x,pausePoint.y);await page.waitForTimeout(150);
    await images.nth(2).evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await page.mouse.click(pausePoint.x,pausePoint.y);await page.waitForTimeout(400);
    assert.equal(await ops(),before+1);
    assert.equal(await images.evaluateAll(items=>items.every(i=>i.style.opacity!=='0')),true);
    await assertQuietReading();report.cases.push(report.currentCase);await screenshot('paused-original');
    report.currentCase='settled far jump cancels a distant held page and starts the current page before its late response';
    await first.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));await toggle();
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
    await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});
    const beforeHeld=await ops(),third=images.nth(2),sixth=images.nth(5);
    await third.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await wait(async()=>(await ops())===beforeHeld+1,15000);
    await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    const heldRequest=await worker.evaluate(()=>globalThis.__mangaTest.operations.at(-1));
    await sixth.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await wait(async()=>(await ops())===beforeHeld+2,10000);
    assert.equal(await worker.evaluate(id=>globalThis.__mangaTest.cancellations.includes(id),heldRequest),true,'Distant request is canceled before its text transport returns');
    await worker.evaluate(()=>globalThis.__mangaTest.releaseHeld?.());
    await wait(async()=>await sixth.evaluate(i=>i.style.opacity==='0'));
    assert.equal(await third.evaluate(i=>i.style.opacity==='0'),false,'Late canceled result cannot revive its old page');
    await assertQuietReading();report.cases.push(report.currentCase);await screenshot('far-jump-current-translated');
    report.engineResidency=await readDiagnostics();
    report.progress=await worker.evaluate(()=>globalThis.__mangaTest.progress);
    report.textBatches=await worker.evaluate(()=>globalThis.__mangaTest.textBatches);
    if(blockedAll)assert.equal(report.modelRequests.length,0);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}

async function verifyScrollStability() {
    assert.equal(prefetchPages,0,'Scroll overlap test processes visible pages only');
    const images=page.locator(readerSelector);
    await page.setViewportSize({width:1280,height:700});
    // Pixiv 的站点 resize 回调可能晚于 CDP viewport 返回；原图快照必须取自本次布局，而不是上次高度。
    let previousLayout='',stableSince=0;
    report.layoutBeforeTranslation=[];
    await wait(async()=>{
        const layout=await images.evaluateAll(items=>items.map(i=>({src:i.src,style:i.getAttribute('style')})));
        const signature=JSON.stringify(layout);
        if(signature!==previousLayout){previousLayout=signature;stableSince=Date.now();report.layoutBeforeTranslation.push({at:stableSince,layout});}
        return Date.now()-stableSince>=300;
    },10000);
    assert.equal(await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed")'),'false');
    await wait(async()=>await images.evaluateAll((items,isPixiv)=>items.some(i=>
        (!isPixiv||i.closest('.gtm-expand-full-size-illust'))&&i.complete&&i.naturalWidth>80&&i.getBoundingClientRect().width>80&&i.getBoundingClientRect().bottom>0&&i.getBoundingClientRect().top<700),pixiv),30000);
    const index=await images.evaluateAll((items,isPixiv)=>items.findIndex(i=>
        (!isPixiv||i.closest('.gtm-expand-full-size-illust'))&&i.complete&&i.naturalWidth>80&&i.getBoundingClientRect().width>80&&i.getBoundingClientRect().bottom>0&&i.getBoundingClientRect().top<700),pixiv);
    assert.ok(index>=0,'Visible loaded reader page found');
    const first=images.nth(index),second=images.nth(index+1);
    assert.ok(await second.count(),'At least two pages are present');
    const originals=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})));
    report.returnDurationsMs=[];report.scrollStability=true;report.overlapSource=liveSite?'actual OCR/inpainting stages':'actual OCR followed by held deterministic text transport';
    const scroll=async image=>{
        await image.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    async function returnFirst(image=first) {
        const duration=await image.evaluate(async i=>{
            const start=performance.now();i.scrollIntoView({block:'start',behavior:'instant'});
            for(let frame=0;frame<90;frame++) {
                await new Promise(resolve=>requestAnimationFrame(resolve));
                if(i.style.opacity==='0')return performance.now()-start;
            }
            throw new Error('Returning translated image did not appear within 90 frames');
        });
        report.returnDurationsMs.push(duration);
        const rect=await image.evaluate(i=>{const r=i.getBoundingClientRect();return {top:r.top,bottom:r.bottom}});
        assert.equal(await imageUi(`return [...this.querySelectorAll('.fluent-read-image-translation-bitmap')].some(i=>{const r=i.getBoundingClientRect();return getComputedStyle(i.parentElement).display!=='none' && r.width>80 && Math.abs(r.top-${rect.top})<2 && r.bottom>0})`),true,'Actual translated bitmap follows the returned image');
        return duration;
    }
    async function noVisibleReversion(image) {
        const samples=await image.evaluate(async i=>{
            const bad=[];
            for(let frame=0;frame<30;frame++) {await new Promise(resolve=>requestAnimationFrame(resolve));
                const r=i.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&i.style.opacity!=='0')bad.push({frame,opacity:i.style.opacity});}
            return bad;
        });
        assert.deepEqual(samples,[],'A translated visible page never flashes back to the original');
    }
    report.currentCase='completed current page remains readable with cache disabled';
    await patch({useCache:false});await scroll(first);const started=Date.now();await toggle();
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
    report.firstPageMs=Date.now()-started;const initialOps=report.initialPageOperations=await ops();
    if(!liveSite)assert.equal(initialOps,1);await assertQuietReading();
    await noVisibleReversion(first);report.cases.push(report.currentCase);
    report.currentCase='next page in progress does not block returning to the translated page';
    if(!liveSite)await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});
    await scroll(second);
    await wait(async()=>(await ops())===initialOps+1,15000);
    if(!liveSite)await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
    assert.equal(await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy")'),'true','Another page is still processing when returning');
    await returnFirst();await noVisibleReversion(first);assert.equal(await ops(),initialOps+1);
    report.cases.push(report.currentCase);await screenshot('return-during-next-page');
    report.currentCase='repeated fast forward/back scrolling reuses the same result without extra OCR';
    for(let attempt=0;attempt<6;attempt++) {await scroll(second);await returnFirst();}
    assert.equal(await ops(),initialOps+1);await assertQuietReading();report.cases.push(report.currentCase);
    report.currentCase='pause restores original host sources and styles; late completion cannot revive translations';
    // 在线阅读器会把初始占位图换成真正的 blob；核对暂停前当前资源，不能要求宿主回到旧占位图。
    const sourcesBeforePause=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes')})));
    await toggle();
    if(!liveSite)await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld?.();});
    await page.waitForTimeout(1000);
    await wait(async()=>await imageUi('return this.querySelectorAll(".fluent-read-image-translation-bitmap").length===0'));
    const restored=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})));
    assert.deepEqual(restored.map(({style,...source})=>source),sourcesBeforePause);
    assert.deepEqual(restored.slice(0,originals.length).map(i=>i.style),originals.map(i=>i.style));report.cases.push(report.currentCase);
    await toggle();await returnFirst();assert.equal(await ops(),initialOps+1);report.cases.push('resume restores the completed visible result without another recognition request');
    await toggle();
    if(!liveSite) {
        await page.reload({waitUntil:'domcontentloaded'});
        await wait(async()=>!!await ball('return this.querySelector(".floating-ball-manga")'),30000);
        const inFlightFirst=page.locator('#page-one'),inFlightNext=page.locator('#page-two');
        report.currentCase='scrolling away before the first result finishes preserves its task and result for return';
        const beforeOverlap=await ops(),cancelBefore=await worker.evaluate(()=>globalThis.__mangaTest.cancellations.length);
        await scroll(inFlightFirst);await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await toggle();
        await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
        await scroll(inFlightNext);assert.equal(await ops(),beforeOverlap+1,'Heavy tasks remain serial');
        assert.equal(await worker.evaluate(()=>globalThis.__mangaTest.cancellations.length),cancelBefore,'Scrolling alone does not cancel the first task');
        await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;globalThis.__mangaTest.releaseHeld();});
        await wait(async()=>(await ops())===beforeOverlap+2&&await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
        await returnFirst(inFlightFirst);await noVisibleReversion(inFlightFirst);assert.equal(await ops(),beforeOverlap+2);
        report.cases.push(report.currentCase);await screenshot('return-after-first-finished-offscreen');
        await toggle();await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld?.();});await page.waitForTimeout(500);
        await patch({useCache:true});await page.reload({waitUntil:'domcontentloaded'});
        await wait(async()=>!!await ball('return this.querySelector(".floating-ball-manga")'),30000);
        const near=page.locator('#page-one'),far=page.locator('#page-five');
        await scroll(near);const before=await ops();await toggle();
        await wait(async()=>await near.evaluate(i=>i.style.opacity==='0'));
        assert.equal(await ops(),before+1);
        report.currentCase='returning from outside the two-page retention window restores a cached bitmap during another request';
        await worker.evaluate(()=>{globalThis.__mangaTest.holdNext=true;});await scroll(far);
        await wait(async()=>await worker.evaluate(()=>!!globalThis.__mangaTest.releaseHeld),90000);
        const heldFarRequest=await worker.evaluate(()=>globalThis.__mangaTest.operations.at(-1));
        assert.equal(await near.evaluate(i=>i.style.opacity),'','Offscreen original is restored after release');
        await returnFirst(near);await noVisibleReversion(near);assert.equal(await ops(),before+2);
        report.cases.push(report.currentCase);await screenshot('cached-return-during-next-page');
        report.currentCase='changing a retained source invalidates its translation and keeps the new original readable';
        await near.evaluate(i=>{i.src=document.querySelector('#page-three').src;});
        await wait(async()=>await near.evaluate(i=>i.complete&&i.style.opacity!=='0'),10000);
        await page.waitForTimeout(300);assert.equal(await near.evaluate(i=>i.style.opacity),'');
        await wait(async()=>(await ops())===before+3,10000);
        assert.equal(await worker.evaluate(id=>globalThis.__mangaTest.cancellations.includes(id),heldFarRequest),true,'New visible source takes priority over obsolete distant work');
        report.cases.push(report.currentCase);
        report.currentCase='chapter change cancels the old request and ignores its late provider result';
        await page.evaluate(()=>{history.pushState(null,'','/viewer/1024051');document.dispatchEvent(new Event('fluentread-route-change'));});
        await wait(async()=>(await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed")'))==='false',10000);
        await worker.evaluate(()=>{globalThis.__mangaTest.releaseHeld?.();});await page.waitForTimeout(1000);
        assert.equal(await imageUi('return this.querySelectorAll(".fluent-read-image-translation-bitmap").length'),0);
        assert.equal(await ops(),before+3);report.cases.push(report.currentCase);
    }
    report.progress=await worker.evaluate(()=>globalThis.__mangaTest.progress);
    report.cancellations=await worker.evaluate(()=>globalThis.__mangaTest.cancellations);
    if(blockedAll)assert.equal(report.modelRequests.length,0);
    assert.ok(!(report.offscreenDiagnostics||[]).some(d=>['warning','error'].includes(d.level)&&d.text.includes('Unknown CPU vendor')));
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}

async function verifyTieredCache(extensionId) {
    assert.equal(liveSite,false);assert.equal(prefetchPages,0);
    report.currentCase='brand manga selects support keyboard, theme, narrow screens and persisted cache capacity';
    await gotoVisible(popup,`chrome-extension://${extensionId}/options.html#settings-image-translation`);
    const root=popup.locator('[data-testid=manga-settings]');await root.waitFor();
    assert.equal(await root.locator('select').count(),0,'Manga fields use branded custom controls');
    assert.match(await popup.getByRole('combobox',{name:'漫画翻译服务',exact:true}).locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," el-select ")][1]').textContent(),/跟随网页翻译服务/);
    const cache=popup.getByRole('combobox',{name:'快速缓存图片数量',exact:true});
    const selected=()=>cache.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," el-select ")][1]').textContent();
    assert.match(await selected(),/12/,'Default fast cache holds twelve normal pages');
    await cache.press('Enter');await popup.locator('.el-popper.fluentread-select-popper:visible').waitFor();
    await popup.waitForTimeout(300);await popup.screenshot({path:path.join(artifacts,'manga-select-light.png')});report.screenshots.push(path.join(artifacts,'manga-select-light.png'));
    await cache.press('ArrowDown');await cache.press('Enter');
    await popup.waitForTimeout(250);
    // Read through the production configuration message, with no assumption about storage serialization.
    const read=()=>popup.evaluate(async()=>{const r=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});return typeof r.value==='string'?JSON.parse(r.value):r.value;});
    assert.equal((await read()).imageTranslationMangaCachePages,13,'Keyboard selection is persisted');
    await cache.press('Enter');await popup.getByRole('option',{name:'2 张图片',exact:true}).click();
    await popup.close();popup=await newPageWithoutForeground(launched.context);await gotoVisible(popup,`chrome-extension://${extensionId}/options.html#settings-image-translation`);
    await popup.locator('[data-testid=manga-settings]').waitFor();assert.equal((await read()).imageTranslationMangaCachePages,2,'Fast close preserves the latest configuration');
    report.persistenceCases=[{field:'imageTranslationMangaCachePages',default:12,keyboard:13,reopened:2,quickClose:true}];
    await patch({theme:'dark'});await popup.reload();await popup.getByRole('combobox',{name:'提前翻译后续页面',exact:true}).press('Enter');
    await popup.locator('.el-popper.fluentread-select-popper:visible').waitFor();await popup.waitForTimeout(300);await popup.screenshot({path:path.join(artifacts,'manga-select-dark.png')});report.screenshots.push(path.join(artifacts,'manga-select-dark.png'));
    await popup.getByRole('combobox',{name:'提前翻译后续页面',exact:true}).press('Escape');await popup.locator('.el-popper.fluentread-select-popper:visible').waitFor({state:'hidden'});
    await popup.setViewportSize({width:390,height:850});await popup.reload();const narrow=popup.getByRole('combobox',{name:'快速缓存图片数量',exact:true});await narrow.scrollIntoViewIfNeeded();await narrow.press('Enter');
    const menu=popup.locator('.el-popper.fluentread-select-popper:visible');await menu.waitFor();const bounds=await menu.boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=391,'Dropdown fits narrow viewport');
    await popup.waitForTimeout(300);await popup.screenshot({path:path.join(artifacts,'manga-select-narrow.png')});report.screenshots.push(path.join(artifacts,'manga-select-narrow.png'));await narrow.press('Escape');
    report.cases.push(report.currentCase);await patch({theme:'light'});await popup.close();popup=await newPageWithoutForeground(launched.context);await gotoVisible(popup,`chrome-extension://${extensionId}/popup.html`);
    await page.setViewportSize({width:800,height:700});
    const pages=['#page-one','#page-four','#page-six'].map(id=>page.locator(id));
    await pages[0].evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));const start=await ops();await toggle();
    const settle=()=>wait(async()=>await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy")')==='false');
    for(let i=0;i<pages.length;i++){
        await pages[i].evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));await wait(async()=>await pages[i].evaluate(i=>i.style.opacity==='0'));await settle();
        assert.equal(await imageUi('return [...this.querySelectorAll(".fluent-read-image-translation-bitmap")].filter(i=>getComputedStyle(i.parentElement).display!=="none").every(i=>i.tagName==="CANVAS")'),true);
    }
    assert.equal(await ops(),start+3);report.cases.push('new manga outputs display composed canvases directly');
    report.currentCase='return from compact cache reconstructs without any extra OCR, translation or full-page PNG encoding';
    report.tieredReturnDurationsMs=[];
    for(let round=0;round<3;round++)for(const image of [pages[0],pages[2]]){
        const ms=await image.evaluate(async i=>{const start=performance.now();i.scrollIntoView({block:'start',behavior:'instant'});for(let frame=0;frame<120;frame++){await new Promise(resolve=>requestAnimationFrame(resolve));if(i.style.opacity==='0')return performance.now()-start;}throw new Error('Compact cache did not restore image');});
        report.tieredReturnDurationsMs.push(ms);await settle();assert.equal(await ops(),start+3);await assertQuietReading();
    }
    await screenshot('tiered-cache-return');report.cases.push(report.currentCase);
    report.currentCase='horizontal navigation reconstructs cached pages with host-safe geometry';
    await page.evaluate(()=>{const reader=document.querySelector('#reader');reader.style.display='flex';reader.style.width='max-content';for(const wrap of reader.children){wrap.style.flexShrink='0';wrap.style.margin='0 50px 0 0';}window.dispatchEvent(new Event('resize'));});
    for(const image of [pages[0],pages[2],pages[0]]){await image.evaluate(i=>i.scrollIntoView({block:'start',inline:'start',behavior:'instant'}));await wait(async()=>await image.evaluate(i=>i.style.opacity==='0'));await settle();assert.equal(await ops(),start+3);}
    await screenshot('tiered-cache-horizontal');report.cases.push(report.currentCase);
    await toggle();assert.equal(await page.locator('.zao-image').evaluateAll(images=>images.every(i=>i.style.opacity!=='0')),true);
    report.cases.push('pause restores every original without reading popovers');
    report.textBatches=await worker.evaluate(()=>globalThis.__mangaTest.textBatches);if(blockedAll)assert.equal(report.modelRequests.length,0);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}

async function verifyCacheNavigation() {
    assert.equal(liveSite,false,'Cache mutation checks belong only to the owned fixture');
    assert.equal(prefetchPages,0,'Navigation checks must not translate unrelated upcoming pages');
    await page.setViewportSize({width:800,height:700});
    const first=page.locator('#page-one'),far=page.locator('#page-five');
    const settle=()=>wait(async()=>await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy")')==='false');
    const visit=async image=>{
        const ms=await image.evaluate(async i=>{
            const start=performance.now();i.scrollIntoView({block:'start',inline:'start',behavior:'instant'});
            for(let frame=0;frame<90;frame++) {await new Promise(resolve=>requestAnimationFrame(resolve));if(i.style.opacity==='0')return performance.now()-start;}
            throw new Error('Cached translated image did not return within 90 frames');
        });
        const rect=await image.evaluate(i=>{const r=i.getBoundingClientRect();return {left:r.left,top:r.top}});
        assert.equal(await imageUi(`return [...this.querySelectorAll('.fluent-read-image-translation-bitmap')].some(i=>{const r=i.getBoundingClientRect();return getComputedStyle(i.parentElement).display!=='none'&&Math.abs(r.left-${rect.left})<2&&Math.abs(r.top-${rect.top})<2})`),true);
        report.cacheReturnDurationsMs.push(ms);
    };
    report.cacheReturnDurationsMs=[];
    await first.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));const before=await ops();await toggle();
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));await settle();assert.equal(await ops(),before+1);
    await far.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await wait(async()=>await far.evaluate(i=>i.style.opacity==='0'));await settle();assert.equal(await ops(),before+2);
    report.currentCase='vertical navigation beyond nearby retention reuses cached bitmaps without another OCR request';
    for(let i=0;i<3;i++){await visit(first);await visit(far);}assert.equal(await ops(),before+2);report.cases.push(report.currentCase);
    await page.evaluate(()=>{
        const reader=document.querySelector('#reader');reader.style.display='flex';reader.style.width='max-content';
        for(const wrap of reader.children){wrap.style.flexShrink='0';wrap.style.margin='0 50px 0 0';}
        window.dispatchEvent(new Event('resize'));
    });
    report.currentCase='horizontal left/right navigation reuses the same cached bitmaps with correct overlay geometry';
    for(let i=0;i<3;i++){await visit(first);await visit(far);}assert.equal(await ops(),before+2);await assertQuietReading();
    report.cases.push(report.currentCase);await screenshot('cache-horizontal-translated');await visit(first);
    report.currentCase='native same-URL image load invalidates completion and performs exactly one fresh recognition';
    const oldSource=await first.getAttribute('src'),beforeReload=await ops();
    await first.evaluate(i=>new Promise((resolve,reject)=>{i.addEventListener('load',resolve,{once:true});i.addEventListener('error',reject,{once:true});i.src=i.src;}));
    await wait(async()=>await ops()===beforeReload+1&&await first.evaluate(i=>i.style.opacity==='0'));await settle();
    assert.equal(await first.getAttribute('src'),oldSource);assert.equal(await ops(),beforeReload+1);report.cases.push(report.currentCase);
    report.currentCase='real OCR of a blank page stores a lightweight completion marker and leaves the original visible';
    const beforeBlank=await ops();await first.evaluate(i=>{
        const canvas=document.createElement('canvas');canvas.width=760;canvas.height=1100;
        const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,760,1100);i.src=canvas.toDataURL('image/png');
    });
    await wait(async()=>await ops()>=beforeBlank+1);await settle();assert.equal(await ops(),beforeBlank+1);assert.equal(await first.evaluate(i=>i.style.opacity),'');
    report.cases.push(report.currentCase);
    report.currentCase='original pause and resume reuse blank-page completion without rerunning OCR';
    await toggle();await toggle();await settle();assert.equal(await ops(),beforeBlank+1);report.cases.push(report.currentCase);
    report.currentCase='blank-page completion survives navigation beyond the nearby window without a bitmap or extra OCR';
    await visit(far);
    await first.evaluate(i=>i.scrollIntoView({block:'start',inline:'start',behavior:'instant'}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await settle();
    assert.equal(await ops(),beforeBlank+1);assert.equal(await first.evaluate(i=>i.style.opacity),'');await assertQuietReading();report.cases.push(report.currentCase);
    report.currentCase='target-language changes invalidate even the lightweight blank-page result';
    await patch({to:'en'});await wait(async()=>await ops()===beforeBlank+2);await settle();assert.equal(await ops(),beforeBlank+2);
    report.cases.push(report.currentCase);await screenshot('cache-blank-original');await toggle();
    assert.equal(await page.locator('.zao-image').evaluateAll(items=>items.every(i=>i.style.opacity!=='0')),true);
    if(blockedAll)assert.equal(report.modelRequests.length,0);
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}

async function verifyReadAhead() {
    report.currentCase='reader detects real image pages and default upcoming-page option';
    const images=page.locator(readerSelector);
    await wait(async()=>await images.evaluateAll(items=>items.some(i=>i.complete&&i.naturalWidth>80&&i.getBoundingClientRect().width>80)),30000);
    report.readerImages=await images.evaluateAll(items=>items.map(i=>{const r=i.getBoundingClientRect();return {width:i.naturalWidth,height:i.naturalHeight,top:r.top,bottom:r.bottom,displayWidth:r.width,src:i.src}}));
    const visibleIndex=pixiv?await images.evaluateAll(items=>items.findIndex(i=>i.closest('.gtm-expand-full-size-illust')&&i.getBoundingClientRect().width>=80&&i.getBoundingClientRect().bottom>0&&i.getBoundingClientRect().top<900)):report.readerImages.findIndex(i=>i.displayWidth>=80&&i.bottom>0&&i.top<900);
    assert.ok(visibleIndex>=0,'At least one loaded reader image is visible');
    const first=images.nth(visibleIndex);
    const originals=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})));
    await screenshot('read-ahead-original');report.cases.push(report.currentCase);
    report.currentCase='current page is shown before upcoming preparation finishes';
    const started=Date.now();await toggle();
    await wait(async()=>(await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy")'))==='true');
    await assertQuietReading();await screenshot('read-ahead-processing-unobstructed');
    await wait(async()=>await first.evaluate(i=>i.style.opacity==='0'));
    report.firstPageMs=Date.now()-started;report.cases.push(report.currentCase);
    await screenshot('read-ahead-first-visible');
    report.currentCase='bounded upcoming pages prepared with real OCR';
    await wait(async()=>(await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-busy")'))==='false');
    report.prepareWindowMs=Date.now()-started;
    report.displayedIndices=await images.evaluateAll(items=>items.flatMap((i,index)=>i.style.opacity==='0'?[index]:[]));
    report.windowOperations=await ops();
    if(pixiv){assert.ok(report.windowOperations>=3,'All three artwork pages were scanned');assert.ok(report.displayedIndices.includes(visibleIndex));assert.ok(!report.displayedIndices.includes(0),'Behind-reader duplicate cover is untouched');}
    else assert.ok(report.windowOperations>=2,'Current page and at least one upcoming page processed');
    if(!liveSite){assert.equal(report.windowOperations,4);assert.equal(await page.locator('#decoy').evaluate(i=>i.style.opacity),'');}
    await screenshot('read-ahead-window-ready');report.cases.push(report.currentCase);
    report.currentCase=pixiv?'no-text upcoming page keeps its original artwork':'prepared upcoming translation follows the image into view';
    const nextIndex=visibleIndex+1;
    const next=images.nth(nextIndex),startedScroll=Date.now();
    await next.evaluate(i=>i.scrollIntoView({block:'start',behavior:'instant'}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await next.evaluate(i=>i.style.opacity),pixiv?'':'0');report.preparedPageScrollMs=Date.now()-startedScroll;
    report.progress=await worker.evaluate(()=>globalThis.__mangaTest.progress);
    const rectangles=await imageUi('return [...this.querySelectorAll(".fluent-read-image-translation-bitmap")].map(i=>{const r=i.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width}})');
    if(!pixiv)assert.ok(rectangles.some(r=>r.width>80&&r.bottom>0&&r.top<900),'Translated bitmap follows the prepared image into the viewport');
    await assertQuietReading();
    await screenshot('read-ahead-next-visible');report.cases.push(report.currentCase);
    report.currentCase='original pause restores all prepared host images';
    const sourcesBeforePause=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes')})));
    await toggle();
    await wait(async()=>await imageUi('return this.querySelectorAll(".fluent-read-image-translation-bitmap").length === 0'));
    // 阅读器翻页可能追加新的懒加载图片；核对原有节点，另行确认追加节点没有残留透明样式。
    const restored=await images.evaluateAll(items=>items.map(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})));
    assert.deepEqual(restored.map(({style,...source})=>source),sourcesBeforePause);
    assert.deepEqual(restored.slice(0,originals.length).map(i=>i.style),originals.map(i=>i.style));
    assert.equal(await images.evaluateAll(items=>items.every(i=>i.style.opacity!== '0')),true);
    report.cases.push(report.currentCase);
    await gotoVisible(popup,`chrome-extension://${new URL(worker.url()).host}/options.html#settings-image-translation`);
    const select=popup.getByRole('combobox',{name:'提前翻译后续页面',exact:true});await select.press('Enter');await popup.getByRole('option',{name:'只翻译当前页面',exact:true}).click();await popup.reload();await wait(async()=>/只翻译当前页面/.test(await select.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," el-select ")][1]').textContent() || ""),10000);report.cases.push('upcoming-page setting persists and allows current-page-only mode');
    report.textBatches=await worker.evaluate(()=>globalThis.__mangaTest.textBatches);
    assert.ok(!(report.offscreenDiagnostics || []).some(d=>['warning','error'].includes(d.level)&&d.text.includes('Unknown CPU vendor')),'Known WASM CPU diagnostic is not a warning or error');
    if(blockedAll){assert.equal(report.modelRequests.length,0);report.cases.push('no model downloads during prepared local reading');}
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
}
(async()=>{
if (process.argv.includes('--worker-diagnostics')) {
    diagnosticFixture=fs.mkdtempSync('/private/tmp/fluentread-manga-diagnostics-');
    fs.cpSync(extensionDir,diagnosticFixture,{recursive:true});extensionDir=diagnosticFixture;
    fs.renameSync(path.join(extensionDir,'mangaInferenceWorker.js'),path.join(extensionDir,'mangaInferenceWorker.real.js'));
    fs.writeFileSync(path.join(extensionDir,'mangaInferenceWorker.js'),`
const early=[],queue=event=>early.push(event);self.addEventListener('message',queue);
const diagnostics={gpuSubmissions:0,pthreads:0,crossOriginIsolated:self.crossOriginIsolated,cores:navigator.hardwareConcurrency,forceCpu:${forceCpu}};
if(${forceCpu})Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
if(self.GPUQueue){const submit=GPUQueue.prototype.submit;GPUQueue.prototype.submit=function(...args){diagnostics.gpuSubmissions++;return submit.apply(this,args);};}
const NativeWorker=self.Worker;self.Worker=class extends NativeWorker{constructor(...args){super(...args);if(args[1]?.name==='em-pthread')diagnostics.pthreads++;}};
const post=self.postMessage.bind(self);self.postMessage=(message,...args)=>post({...message,diagnostics:{...diagnostics}},...args);
await import('./mangaInferenceWorker.real.js');self.removeEventListener('message',queue);for(const event of early)self.onmessage?.(event);
`);
}
    profile = fs.mkdtempSync('/private/tmp/fluentread-manga-profile-');
    launchAttempted = true;
    launched=await launchFocusSafePersistentContext({chromium,profileDir:profile,
        browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,
        browserArgs:[...(extensionDebugging?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`]),'--no-first-run','--no-default-browser-check'],
        viewport:{width:1280,height:900},displayTarget:"secondary",timeout:30000});
    Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
    assert.equal(report.launchMode,'macos-background-cdp');
    assert.equal(report.focusPolicy,'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode,'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost,false);
    const context=launched.context;
    const system=await context.browser().newBrowserCDPSession();browserPid=(await system.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id;if(extensionDebugging){report.extensionLoad=await system.send('Extensions.loadUnpacked',{path:extensionDir});loadedExtensionId=report.extensionLoad.id;}await system.detach();focusGuard();
    report.blockedOfficial=blockedOfficial;report.blockedAllModelSources=blockedAll;report.modelRequests=[];
    context.on('console',message=>{if(message.type()==='error'&&message.text().includes('FluentRead'))report.consoleErrors.push(message.text());});
    if(loadedExtensionId)await context.pages()[0].goto(`chrome-extension://${loadedExtensionId}/popup.html`);
    const ownWorker=w=>w.url().startsWith(loadedExtensionId?`chrome-extension://${loadedExtensionId}/`:'chrome-extension://');
    worker=context.serviceWorkers().find(ownWorker)||await context.waitForEvent('serviceworker',{predicate:ownWorker,timeout:30000});
    const extensionId=new URL(worker.url()).host;

    popup=context.pages()[0];
    const options=popup,reopened=popup,modelSettings=popup;
    await gotoVisible(popup,`chrome-extension://${extensionId}/popup.html`);
    await patch({on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,disableImageTranslator:false,
        imageTranslationMangaEnabled:!ordinaryImageQuality,imageTranslationMangaDownloadConfirmed:true,imageTranslationMangaPromptEnabled:false,imageTranslationHoverEnabled:ordinaryImageQuality,disableFloatingBall:ordinaryImageQuality,
        ...(ordinaryImageQuality?{imageTranslationOcrEngine:'paddle'}:{}),
        imageTranslationMangaPrefetchPages:prefetchPages,
        service:'google',from:sourceLanguage,to:targetLanguage,useCache:true,enableAIContext:false,animations:false});
    await worker.evaluate(({live,trace,traceLayout,layoutTraceLimit})=>{
        const original=globalThis.fetch.bind(globalThis);
        const test=globalThis.__mangaTest={operations:[],inputs:[],requests:[],transportRequests:[],cancellations:[],textBatches:[],progress:[],sourceRequests:[]};
        if(traceLayout){
            test.layoutResults=[];
            const send=chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage=function(...args){
                const message=args[0],observe=response=>{
                    if(message?.type==='FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN'&&Array.isArray(response?.lines)&&test.layoutResults.length<layoutTraceLimit)
                        test.layoutResults.push({requestId:message.requestId,noBitmap:response.success===true&&message.manga===true&&(Array.isArray(response.mangaPatches?.patches)&&response.mangaPatches.patches.length===0||response.lines.length===0&&typeof response.image==='string'&&response.image===message.image),lines:response.lines.map(({text,sourceText,bbox,fontSize,sourceBoxes,vertical})=>({text,sourceText,bbox,fontSize,sourceBoxes,vertical}))});
                    return response;
                };
                const last=args.length-1,callback=args[last];
                if(typeof callback==='function')args[last]=response=>callback(observe(response));
                const result=send(...args);return typeof callback!=='function'&&result?.then?result.then(observe):result;
            };
        }
        chrome.runtime.onMessage.addListener((message,sender)=>{
            if(message.type==='fluentReadImageFetch'){
                const clean=value=>{try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return null;}};
                test.sourceRequests.push({documentUrl:clean(sender.url),sourceUrl:clean(message.url),frameId:sender.frameId});
            }
            if(message.type==='fluentReadImageTranslate') {
                test.operations.push(message.requestId);
                if(trace) {
                    let hash=2166136261;for(const char of message.image)hash=Math.imul(hash^char.charCodeAt(0),16777619);
                    test.inputs.push({at:Date.now(),requestId:message.requestId,format:message.image.match(/^data:([^;,]+)/)?.[1] || 'unknown',bytes:message.image.length,hash:hash>>>0});
                }
            }
            if(message.type==='fluentReadImageProgress')test.progress.push({at:Date.now(),requestId:message.requestId,stage:message.stage,progress:message.progress});
            if(message.type==='fluentReadImageCancel')test.cancellations.push(message.requestId);
            if(message.type==='fluentReadImageTranslateTexts')test.textBatches.push(message.texts);
            return false;
        });
        globalThis.fetch=async(input,options)=>{
            const url=String(typeof input==='string'?input:input.url||input);
            const endpoint=new URL(url);
            const html=endpoint.hostname==='translate-pa.googleapis.com'&&endpoint.pathname==='/v1/translateHtml';
            const list=endpoint.hostname==='translate.googleapis.com'&&endpoint.pathname==='/translate_a/t';
            const rpc=['translate.google.com','translate.google.co.uk'].includes(endpoint.hostname)&&endpoint.pathname==='/_/TranslateWebserverUi/data/batchexecute';
            if(html||list||rpc){
                const entries=rpc?JSON.parse(new URLSearchParams(options.body).get('f.req'))[0]:null;
                const texts=html?JSON.parse(options.body)[0][0]:list?new URLSearchParams(options.body).getAll('q'):entries.map(entry=>JSON.parse(entry[1])[0][0]);
                test.requests.push(...texts);test.transportRequests.push({endpoint:html?'translateHtml':list?'translate_a/t':'batchexecute',items:texts.length,live});
                if(live)return original(input,options);
                if(test.holdNext) {test.holdNext=false;await new Promise(resolve=>{test.releaseHeld=()=>{delete test.releaseHeld;resolve();};});}
                await new Promise(resolve=>setTimeout(resolve,250));
                const translations=texts.map(()=> '流畅阅读：看懂每一页漫画');
                if(html)return new Response(JSON.stringify([translations.map(text=>`<pre>${text}</pre>`)]),{status:200});
                if(list)return new Response(JSON.stringify(translations),{status:200});
                const entry=[null,null,null,null,null,[['流畅阅读：看懂每一页漫画']]];
                return new Response(JSON.stringify(entries.map(request=>['wrb.fr','MkEWBc',JSON.stringify([null,[[entry]]]),null,null,null,request[3]])),{status:200});
            }
            if(!live&&/^(?:translate(?:-pa)?\.googleapis\.com|translate\.google\.(?:com|co\.uk))$/.test(endpoint.hostname))throw new Error('Unexpected Google fixture transport');
            return original(input,options);
        };
    },{live:liveTranslation,trace:traceReader,traceLayout,layoutTraceLimit});
    await worker.evaluate(async()=>{await chrome.offscreen.createDocument({url:chrome.runtime.getURL('offscreen.html'),reasons:['DOM_PARSER'],justification:'Verify local manga processing in an isolated test profile'});});
    modelObserver=await observeModelDownloads(extensionId);
    if(scrollIntentTest)await modelObserver.command('Runtime.evaluate',{expression:`(()=>{
        const diagnostic=globalThis.__mangaResidency={created:0,terminated:0,events:[]};
        const NativeWorker=globalThis.Worker;
        globalThis.Worker=class extends NativeWorker {
            constructor(url,options) {
                super(url,options);
                if(!String(url).includes('mangaInferenceWorker'))return;
                const id=++diagnostic.created;
                this.addEventListener('message',event=>{
                    const {requestId,stage,success}=event.data||{};
                    diagnostic.events.push({id,at:Date.now(),requestId,stage,success});
                });
                const terminate=this.terminate.bind(this);
                this.terminate=()=>{diagnostic.terminated++;return terminate();};
            }
        };
    })()`});
    if(traceLayout)await modelObserver.command('Runtime.evaluate',{expression:`(()=>{
        const samples=globalThis.__mangaLayoutTrace=[];
        const boxes=new WeakMap(),rect=CanvasRenderingContext2D.prototype.rect,draw=CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.rect=function(x,y,width,height){boxes.set(this,{x,y,width,height});return rect.call(this,x,y,width,height);};
        CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
            if(this.font.includes('Noto Sans')&&samples.length<1024)samples.push({text,x,y,font:this.font,canvas:{width:this.canvas.width,height:this.canvas.height},box:boxes.get(this)});
            return draw.call(this,text,x,y,...args);
        };
    })()`});
    if(!liveSite)await context.route(targetUrl,route=>route.fulfill({status:200,contentType:'text/html',body:
        errorRecoveryTest&&errorRecoverySurface!=='image'?recoverySurfaceFixture(errorRecoverySurface):
            pipelineInputs?fixture.replace("canvas.toBlob(blob=>{image.src=URL.createObjectURL(blob)})","image.src=canvas.toDataURL('image/png')"):fixture}));
    page=await newPageWithoutForeground(context);page.on('pageerror',error=>{
        const stack=error.stack||'';
        report.pageErrors.push({message:error.message,stack});
        if(liveSite&&!stack.includes('chrome-extension://')&&/https?:\/\//.test(stack))report.hostErrors.push({message:error.message,stack});
        else report.errors.push(error.message);
    });
    await gotoVisible(page,targetUrl,{waitUntil:'domcontentloaded',timeout:60000});
    if(errorRecoveryTest&&errorRecoverySurface!=='image'){
        await page.waitForFunction(()=>!!globalThis.__recoverySurfaceFixture);
        const setup=await page.evaluate(()=>globalThis.__recoverySurfaceFixture);report.errorRecovery.fixture=setup;
        assert.equal(setup.error,undefined,'Controlled recovery fixture source generation succeeds');
        assert.equal(setup.ready,true);assert.equal(await page.locator(readerSelector).count(),setup.sourceCount);
    }
    // 先建立浏览器/CDP 所有权并完成正文导航；只有实际可用的导入 UI 才准备模型，失败生命周期不触发文件或网络活动。
    // 下载来源回退/离线导入保持原有负向语义，不能让自动缓存掩盖它们。
    const useModelCache=!preloadModels&&!offlineModels&&!blockedOfficial&&!blockedAll&&!baseline;
    if(preloadModels||useModelCache){
        await gotoVisible(modelSettings,`chrome-extension://${extensionId}/options.html#settings-image-translation`);
        const manager=modelSettings.locator('.manga-model-settings');
        await manager.waitFor();
        if(!baseline)await manager.locator('.manga-download-settings').evaluate(details=>details.open=true);
        const importInput=manager.locator('input[type=file]');
        await importInput.waitFor({state:'attached'});
        if(useModelCache){
            const needsPaddle=(qualityFixtures?.map(fixture=>fixture.sourceLanguage)||[sourceLanguage]).some(language=>!['ru','ko'].includes(language));
            const kinds=ordinaryImageQuality?['ocr']:needsPaddle?['ocr','inpaint']:['inpaint'];
            preparedModels=await ensureImageTranslationModelFiles({directory:modelCacheDir,kinds,sourceDirectories:[modelCacheDir],allowNetworkDownload:!noCacheDownload});
            report.modelCache=preparedModels;
        }
        const files=preparedModels?.files||readImageTranslationModelManifest().map(asset=>({...asset,path:path.join(preloadModels,asset.filename)}));
        await importInput.setInputFiles(files.map(file=>file.path));
        const requiredOcr=files.some(file=>file.kind==='ocr'),requiredInpaint=files.some(file=>file.kind==='inpaint');
        const until=Date.now()+60000;let status;
        while(Date.now()<until){
            status=await modelSettings.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}));
            if(status.success&&(!requiredOcr||status.ready)&&(!requiredInpaint||status.inpaintingReady))break;
            const failure=await manager.locator('[role=alert]').allTextContents();
            assert.ok(!failure.some(text=>text.trim()),`Model import failed: ${failure.join('; ')}`);
            await modelSettings.waitForTimeout(150);
        }
        assert.ok(status?.success&&(!requiredOcr||status.ready)&&(!requiredInpaint||status.inpaintingReady),'Required imported resources are ready before leaving settings');
        report.preloadedModelStatus=status;
        const audit=async()=>{const cache=await caches.open('fluent-read-manga-ocr-v1');return Promise.all((await cache.keys()).map(async key=>{const response=await cache.match(key);const bytes=await response.arrayBuffer();return {url:key.url,status:response.status,bytes:bytes.byteLength,sha:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')}}));};
        report.preloadedCacheOptions=await modelSettings.evaluate(audit);
        const audited=await modelObserver.command('Runtime.evaluate',{expression:`(${audit.toString()})()`,returnByValue:true,awaitPromise:true});
        assert.equal(audited.exceptionDetails,undefined,'Offscreen model cache audit executes');
        report.preloadedCacheOffscreen=audited.result.value;
        for(const entries of [report.preloadedCacheOptions,report.preloadedCacheOffscreen])for(const file of files){
            const entry=entries.find(entry=>entry.url===file.url);
            assert.ok(entry,`Imported model is visible before navigation: ${file.filename}`);
            assert.equal(entry.status,200);assert.equal(entry.bytes,file.bytes);assert.equal(entry.sha,file.sha256);
        }
        report.modelsPreloaded=true;report.modelRequestsAfterPreload=report.modelRequests.length;await gotoVisible(popup,`chrome-extension://${extensionId}/popup.html`);
    }else report.modelCache={directory:modelCacheDir,skipped:'explicit model-source, offline-import or baseline case'};
    if(readerOpenSelector)await page.locator(readerOpenSelector).click({timeout:15000});
    cdp=await context.newCDPSession(page);
    if(canvasContentPixels)cdp.on('Runtime.executionContextCreated',event=>{if(event.context.origin===`chrome-extension://${extensionId}`&&event.context.auxData?.type==='isolated')contentPixelContext=event.context.id;});
    if(liveSite||traceReader) {
        const scripts=new Map(),contexts=new Map();report.scriptExceptions=[];
        cdp.on('Runtime.executionContextCreated',event=>contexts.set(event.context.id,event.context));
        if(traceReader)cdp.on('Debugger.scriptParsed',script=>scripts.set(script.scriptId,{url:script.url,sourceMapURL:script.sourceMapURL}));
        cdp.on('Runtime.exceptionThrown',event=>report.scriptExceptions.push({details:event.exceptionDetails,context:contexts.get(event.exceptionDetails.executionContextId),scripts:(event.exceptionDetails.stackTrace?.callFrames||[]).map(frame=>scripts.get(frame.scriptId))}));
        if(traceReader)await cdp.send('Debugger.enable');await cdp.send('Runtime.enable');
    }
    if(liveSite&&!surfaceReaderTest){const reject=page.locator('#onetrust-reject-all-handler');await reject.waitFor({timeout:12000}).then(()=>reject.click()).catch(()=>undefined);}
    if(surfaceReaderTest){
        if(canvasOpenSelector)await page.locator(canvasOpenSelector).click();
        if(explicitCanvasSelector){
            // 等到正文已经绘制再发送按键；服务端 DOM 先到时阅读器尚未绑定翻页事件。
            if(canvasContentPixels)await wait(async()=>evaluateReaderElements(elements=>elements.some(c=>{
                const r=c.getBoundingClientRect();if(!c.width||!c.height||r.width<=80||r.height<=40||r.left>=innerWidth||r.right<=0||r.top>=innerHeight||r.bottom<=0)return false;
                try{return c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[3]>0;}catch{return false;}
            })),30000);
            else await page.waitForFunction(({selector,background})=>[...document.querySelectorAll(selector)].some(c=>{
                const r=c.getBoundingClientRect();if((!background && (!c.width||!c.height))||r.width<=80||r.height<=40||r.left>=innerWidth||r.right<=0||r.top>=innerHeight||r.bottom<=0)return false;
                if(background)return getComputedStyle(c).backgroundImage.startsWith('url(\"blob:');
                try{return c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[3]>0;}catch{return false;}
            }),{selector:readerSelector,background:backgroundReaderTest});
            await page.waitForTimeout(900+canvasReadySettleMs);
        }
        for(let turn=0;turn<canvasInitialTurns;turn++){await page.keyboard.press(canvasTurnKey);await page.waitForTimeout(900);}
    }
    if(pixiv) {
        await page.locator(readerSelector).first().waitFor();
        const read=page.getByText('阅读作品',{exact:true});
        const alreadyOpen=await page.locator(readerSelector).evaluateAll(items=>items.some(i=>!i.closest('main')&&i.getBoundingClientRect().width>80));
        if(!alreadyOpen&&await read.isVisible().catch(()=>false))await read.click({timeout:5000});
    }
    if(surfaceReaderTest)await page.waitForFunction(selector=>[...document.querySelectorAll(selector)].some(c=>{const r=c.getBoundingClientRect();return r.width>80&&r.height>40&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;}),readerSelector);
    else {
        if(explicitReaderSelector&&!segmentReaderTest)await scrollReaderImage(0);
        else await page.locator(readerSelector).first().waitFor();
    }
    if(imageTurnKey){
        await page.waitForTimeout(900);
        for(let turn=0;turn<imageInitialTurns;turn++){
            const before=imageVisibleSource?(await visibleReaderImageSource())?.src:await page.locator(readerSelector).first().evaluate(i=>i.src);
            assert.ok(before,'A loaded visible public source exists before a normal page turn');
            await page.keyboard.press(imageTurnKey);
            await wait(async()=>{
                if(imageVisibleSource){const image=await visibleReaderImageSource();return !!image&&image.src!==before;}
                return page.locator(readerSelector).first().evaluate((i,old)=>i.complete&&i.naturalWidth>=80&&i.src!==old,before);
            },30000);
            await page.waitForTimeout(900);
        }
        await wait(async()=>await page.locator(readerSelector).first().evaluate(i=>i.complete&&i.naturalWidth>=80),30000);
    }
    if(surfaceReaderTest)await page.waitForTimeout(900);
    if(traceReader)await page.evaluate(selector=>{
        const ids=new WeakMap();let next=0;const traces=globalThis.__readerTrace=[];
        const capture=reason=>traces.push({at:Date.now(),reason,images:[...document.querySelectorAll(selector)].map(i=>{
            if(!ids.has(i))ids.set(i,++next);const rect=i.getBoundingClientRect();
            return {id:ids.get(i),src:i.currentSrc,raw:i.getAttribute('src'),srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),complete:i.complete,width:i.naturalWidth,height:i.naturalHeight,top:rect.top,bottom:rect.bottom,expanded:!!i.closest('.gtm-expand-full-size-illust')};
        })});
        capture('initial');new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.target.matches?.(selector)))capture('mutation');}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','srcset','sizes']});
        addEventListener('scroll',()=>capture('scroll'),true);
        document.addEventListener('load',event=>{if(event.target.matches?.(selector))capture('load:'+event.target.id);},true);
    },readerSelector);
    if(!ordinaryImageQuality)await wait(async()=>!!await ball(`return this.querySelector('.floating-ball-manga')`),30000);
    if(segmentReaderTest){await verifySegmentReader();report.status='passed';return;}
    if(surfaceReaderTest){await verifyCanvasReader();report.status='passed';return;}
    if(imageTurnKey){await verifyPagedImageReader();report.status='passed';return;}
    if(pipelineInputs){await verifyPipelinePerformance(extensionId);report.status='passed';return;}
    if(errorRecoveryTest){await verifyErrorRecovery();report.status='passed';focusGuard();return;}
    if(pageFeedbackTest){await verifyPageFeedback();report.status='passed';focusGuard();return;}
    if(tieredCacheTest){await verifyTieredCache(extensionId);report.status='passed';focusGuard();return;}
    if(cacheNavigationTest){await verifyCacheNavigation();report.status='passed';focusGuard();return;}
    if(scrollIntentTest){await verifyScrollIntent();report.status='passed';focusGuard();return;}
    if(scrollStabilityTest){await verifyScrollStability();report.status='passed';focusGuard();return;}
    if(readAheadTest){await verifyReadAhead();report.status='passed';focusGuard();return;}
    report.currentCase='one click activates and translates only visible pages';
    const source=page.locator(readerSelector).nth(readerStartIndex);
    if(readerStartIndex)await scrollReaderImage(readerStartIndex);
    await wait(async()=>await source.evaluate(i=>i.complete && i.naturalWidth>=80),30000);
    const original=await source.evaluate(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')}));
    await captureSource(source,'01');
    let started=Date.now();report.pageDurationsMs=[];
    await toolScreenshot('idle');await toggle();
    await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='true',10000);
    await toolScreenshot('pending');
    if(!baseline){await assertQuietReading();await screenshot('pending-unobstructed');}
    if(report.buttonStates.pending.busy==='true')assert.equal(report.buttonStates.pending.badge,undefined,'Pending shows progress instead of a completion check');
    if(!skipFirstCancel){
    report.currentCase='cancel first preparation restores originals and can resume';
    await toggle();await wait(async()=>(await worker.evaluate(()=>globalThis.__mangaTest.cancellations.length))>0);
    assert.equal(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`),0);
    assert.deepEqual(await source.evaluate(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})),original);
    report.cases.push(report.currentCase);await toggle();
    }
    report.currentCase='one click activates and translates only visible pages';
    await wait(async()=>(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`))>0);
    await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='false');
    assert.equal(await source.evaluate(i=>i.style.opacity),'0','The observed source has its translated bitmap displayed');
    assert.equal(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-pressed')`),'true');
    report.pageDurationsMs.push({page:1,ms:Date.now()-started,includesFirstModelPreparation:true});
    await toolScreenshot('active');assert.ok(report.buttonStates.active.badge>=19);
    if(!liveSite){assert.ok((await ops())<=2,'Only the visible page and its canceled preparation/retry run');
        assert.equal(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-overlay').length`),1);}
    report.firstOperationCount=await ops();report.cases.push(report.currentCase);
    if(!baseline){await assertQuietReading();report.cases.push('translated reading has no automatic panel');}
    await screenshot('01-translated');
    report.currentCase='original pauses and repeated toggles reuse visible results';
    await toggle();await wait(async()=>(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`))===0);
    assert.deepEqual(await source.evaluate(i=>({src:i.src,srcset:i.getAttribute('srcset'),sizes:i.getAttribute('sizes'),style:i.getAttribute('style')})),original);
    const before=await ops();await toggle();await wait(async()=>(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`))>0);
    assert.equal(await ops(),before);report.cases.push(report.currentCase);
    if(qualityPages>=2){
    report.currentCase=readerNextSelector?'normal reader page turn translates a new visible page':'scroll automatically translates a new visible page';
    const second=page.locator(readerSelector).nth(readerStartIndex+1);started=Date.now();await scrollReaderImage(readerStartIndex+1);
    await captureSource(second,'02');
    // 可见页可能已在此前的阅读窗口完成，直接显示缓存也是正确的滚动结果。
    await wait(async()=>await second.evaluate(i=>i.style.opacity==='0'));
    await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='false');
    assert.ok((await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`))>0);
    assert.equal(await second.evaluate(i=>i.style.opacity),'0','The new observed page displays its own translated result');
    const afterScroll=await ops();assert.ok(afterScroll>=before);
    report.scrollOperationCounts={before,after:afterScroll,mode:afterScroll>before?'new-operation':'existing-result'};
    report.pageDurationsMs.push({page:2,ms:Date.now()-started,mayIncludeFirstInpaintingPreparation:true});
    await screenshot('02-scrolled-translated');report.cases.push(report.currentCase);
    }else report.singlePageScope='One public body image only; activation, actual OCR/translation, original restoration and cached resume. No next-page or whole-chapter claim.';
    if(liveSite)for(let index=2;index<qualityPages;index++){
        if(index===3 && readingPauseMs){report.readingPauseMs=readingPauseMs;await page.waitForTimeout(Math.min(60000,readingPauseMs));if(readingPauseMs>60000)await page.waitForTimeout(readingPauseMs-60000);}
        report.currentCase=`live page ${index+1} translates automatically`;
        const previous=await ops(), image=page.locator(readerSelector).nth(readerStartIndex+index);started=Date.now();
        await scrollReaderImage(readerStartIndex+index);await captureSource(image,String(index+1).padStart(2,'0'));
        await wait(async()=>await image.evaluate(i=>i.style.opacity==='0'));
        await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='false');
        assert.ok((await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`))>0);
        assert.equal(await image.evaluate(i=>i.style.opacity),'0');
        (report.additionalScrollOperationCounts??=[]).push({page:index+1,before:previous,after:await ops()});
        report.pageDurationsMs.push({page:index+1,ms:Date.now()-started});
        await screenshot(`${String(index+1).padStart(2,'0')}-dialogue-translated`);report.cases.push(report.currentCase);
    }
    if(!liveSite){
        report.currentCase='dynamic image discovery and source replacement';
        await page.evaluate(()=>window.addPage('Dynamic manga page','page-four'));
        await page.locator('#page-four').scrollIntoViewIfNeeded();let previous=await ops();
        await wait(async()=>(await ops())>previous);await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='false');
        previous=await ops();await page.locator('#page-four').evaluate(i=>{const canvas=document.createElement('canvas');canvas.width=760;canvas.height=1100;
            const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,760,1100);ctx.fillStyle='black';ctx.font='48px Arial';ctx.fillText('Source changed',90,200);canvas.toBlob(b=>{i.src=URL.createObjectURL(b)});});
        await wait(async()=>(await ops())>previous);await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-busy')`))==='false');
        assert.equal(await page.locator('#decoy').evaluate(i=>i.style.opacity),'');report.cases.push(report.currentCase);
        report.currentCase='text-free page retains original and completes without an error';
        await page.evaluate(async()=>{
            const canvas=document.createElement('canvas');canvas.width=760;canvas.height=1100;
            const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,760,1100);
            const blob=await new Promise(resolve=>canvas.toBlob(resolve));
            const wrap=document.createElement('div');wrap.className='zao-image-container';const image=document.createElement('img');
            image.className='zao-image';image.id='blank-page';image.src=URL.createObjectURL(blob);wrap.append(image);document.querySelector('#reader').append(wrap);
        });
        await page.locator('#blank-page').scrollIntoViewIfNeeded();
        await wait(async()=>await imageUi('return [...this.querySelectorAll(".fr-image-status")].some(status=>status.textContent.includes("未检测到文字，已保留原图"))'),60000);
        await wait(async()=>await ball('return this.querySelector(".floating-ball-manga").getAttribute("aria-busy")')==='false',10000);
        assert.equal(await ball('return !!this.querySelector(".manga-error")'),false);
        assert.notEqual(await page.locator('#blank-page').evaluate(i=>i.style.opacity),'0');
        await toolScreenshot('text-free-page');report.cases.push(report.currentCase);
        if(!baseline){await assertQuietReading();report.cases.push('text-free page never opens a reading panel');}
        report.currentCase='chapter change resets continuous mode and restores originals';
        await page.evaluate(()=>history.pushState({},'', '/viewer/555'));
        await wait(async()=>(await ball(`return this.querySelector('.floating-ball-manga').getAttribute('aria-pressed')`))==='false');
        assert.equal(await imageUi(`return this.querySelectorAll('.fluent-read-image-translation-bitmap').length`),0);report.cases.push(report.currentCase);
    }
    if(!baseline){
        if(liveSite){await assertQuietReading();report.cases.push('scroll and hover never open a reading panel');}
        report.currentCase='manga control stays compact beneath the resident brand icon';
        const metrics=await ball(`const a=this.querySelector('.floating-ball-manga').getBoundingClientRect(),b=this.querySelector('.floating-ball-main').getBoundingClientRect();return {manga:a.width,brand:b.width}`);
        assert.equal(metrics.brand,32);assert.equal(metrics.manga,32);report.buttonSize=metrics;report.cases.push(report.currentCase);
    }
    if(readerSmoke){auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.status='passed';focusGuard();return;}
    report.currentCase='settings switch persists across unmount and reopen';
    await patch({imageTranslationMangaEnabled:false});
    await wait(async()=>!(await ball(`return !!this.querySelector('.floating-ball-manga')`)));
    await gotoVisible(options,`chrome-extension://${extensionId}/options.html#settings-image-translation`);
    await options.getByRole('switch',{name:baseline?'显示漫画翻译按钮':'漫画连续翻译',exact:true}).waitFor({state:'attached'});
    assert.equal(await options.getByRole('switch',{name:baseline?'显示漫画翻译按钮':'漫画连续翻译',exact:true}).getAttribute('aria-checked'),'false');
    const mangaSwitch=options.getByRole('switch',{name:baseline?'显示漫画翻译按钮':'漫画连续翻译',exact:true});
    if(baseline)await options.locator('.el-switch').filter({has:mangaSwitch}).click();else await mangaSwitch.click();
    await gotoVisible(options,`chrome-extension://${extensionId}/popup.html`);
    await gotoVisible(reopened,`chrome-extension://${extensionId}/options.html#settings-image-translation`);
    await reopened.getByRole('switch',{name:baseline?'显示漫画翻译按钮':'漫画连续翻译',exact:true}).waitFor({state:'attached'});
    assert.equal(await reopened.getByRole('switch',{name:baseline?'显示漫画翻译按钮':'漫画连续翻译',exact:true}).getAttribute('aria-checked'),'true');
    const settingsShot=path.join(artifacts,'03-settings-reopened.png');await reopened.screenshot({path:settingsShot});report.screenshots.push(settingsShot);
    await gotoVisible(reopened,`chrome-extension://${extensionId}/popup.html`);report.cases.push(report.currentCase);
    report.currentCase='master disable removes image UI and restores all source styles';
    await patch({on:false});await wait(async()=>(await page.locator('#fluent-read-image-translation-root').count())===0);
    assert.equal(await page.locator('.zao-image').evaluateAll(images=>images.filter(i=>i.style.opacity==='0').length),0);
    report.cases.push(report.currentCase);
    report.currentCase='cached manga model status and clear action';
    report.modelStatusBefore=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}));
    assert.equal(report.modelStatusBefore.ready,true);assert.ok(report.modelStatusBefore.bytes>30000000);
    await gotoVisible(modelSettings,`chrome-extension://${extensionId}/options.html#settings-image-translation`);

    if(!baseline)await modelSettings.locator('.manga-download-settings > summary').click();
    await modelSettings.getByRole('button',{name:baseline?'清除漫画模型':'清除已下载资源',exact:true}).waitFor();
    const assertAutomaticModelUi=async()=>{
        const manager=modelSettings.locator('.manga-model-settings');
        assert.equal(await manager.getByRole('combobox',{name:'模型下载来源',exact:true}).count(),0);
        assert.equal(await manager.locator('a[href*="huggingface"],a[href*="hf-mirror"],a[href*="modelscope"]').count(),0);
        assert.doesNotMatch(await manager.innerText(),/下载来源|官方源优先|备用镜像优先|Hugging Face|HF Mirror|ModelScope|huggingface\.co|hf-mirror|modelscope\.cn/iu);
        assert.equal(await manager.getByRole('button',{name:'导入已下载文件',exact:true}).count(),1);
    };
    if(baseline)await modelSettings.getByLabel('模型下载来源',{exact:true}).selectOption('mirror');
    else await assertAutomaticModelUi();
    await modelSettings.reload();

    const expectedModelSource=baseline?'mirror':'auto';
    await wait(async()=>(await modelSettings.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}))).source===expectedModelSource);
    if(!baseline)await modelSettings.locator('.manga-download-settings > summary').click();
    if(!baseline)await assertAutomaticModelUi();
    report.cases.push(baseline?'model source selection persists on reopen':'model management remains automatic on reopen without source controls or provider links');
    await modelSettings.locator('.manga-model-settings').scrollIntoViewIfNeeded();
    const modelShot=path.join(artifacts,'models-before-clear.png');await modelSettings.screenshot({path:modelShot});report.screenshots.push(modelShot);
    await modelSettings.getByRole('button',{name:baseline?'清除漫画模型':'清除已下载资源',exact:true}).click();
    if(baseline)await modelSettings.locator('.manga-model-settings small').filter({hasText:/^(?:已占用空间 · )?0 MB$/}).waitFor();
    else await modelSettings.locator('.manga-resource-state').first().filter({hasText:'未下载'}).waitFor();
    report.modelStatusAfter=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}));
    assert.deepEqual(report.modelStatusAfter,{success:true,ready:false,bytes:0,inpaintingReady:false,source:expectedModelSource});
    if(offlineModels){
        await modelSettings.locator('.manga-model-settings input[type=file]').setInputFiles(['PP-OCRv6_small_det.onnx','PP-OCRv6_small_rec.onnx','ppocrv6_dict.txt','lama-manga-dynamic.onnx'].map(name=>path.join(offlineModels,name)));
        await modelSettings.locator('.manga-model-settings small').filter({hasText:'226 MB'}).waitFor({timeout:60000});
        report.offlineStatus=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}));
        assert.equal(report.offlineStatus.ready,true);assert.equal(report.offlineStatus.inpaintingReady,true);
        report.cases.push('offline files import and verify without model network requests');
        const offlineShot=path.join(artifacts,'models-offline-imported.png');await modelSettings.screenshot({path:offlineShot});report.screenshots.push(offlineShot);
        await patch({theme:'dark'});await modelSettings.waitForFunction(()=>document.documentElement.classList.contains('dark'));
        await modelSettings.setViewportSize({width:420,height:900});await modelSettings.locator('.manga-model-settings').scrollIntoViewIfNeeded();
        const bounds=await modelSettings.locator('.manga-model-settings').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=421);
        const darkShot=path.join(artifacts,'models-dark-mobile.png');await modelSettings.screenshot({path:darkShot});report.screenshots.push(darkShot);
        report.cases.push('model controls fit narrow viewport and dark theme');
        await modelSettings.getByRole('button',{name:baseline?'清除漫画模型':'清除已下载资源',exact:true}).click();
        if(baseline)await modelSettings.locator('.manga-model-settings small').filter({hasText:/^(?:已占用空间 · )?0 MB$/}).waitFor();
        else await modelSettings.locator('.manga-resource-state').first().filter({hasText:'未下载'}).waitFor();
    }
    report.cases.push(report.currentCase);
    report.progress=await worker.evaluate(()=>globalThis.__mangaTest.progress);
    report.operations=await ops();report.translationRequests=await worker.evaluate(()=>globalThis.__mangaTest.requests.length);
    report.textBatches=await worker.evaluate(()=>globalThis.__mangaTest.textBatches);
    if(liveSite&&qualityPages>=5){
        const all=report.textBatches.flat().join(' ').toUpperCase().replace(/\s+/g,'');
        for(const phrase of ['IHAVEAFAVORTOASKOFYOUONHISBEHALF','HESHOULDHAVEABOUTTENMILLIONDOLLARSONHIM','THEPOSSESSOROFTHEGOLDENARMS','BUTGOAFTERMYPREY','YOUINSULTME'])assert.ok(all.includes(phrase),`Recognized complete dialogue: ${phrase}`);
        report.cases.push('key complete dialogue recognized on three later pages');
    }
    if(blockedAll)report.cases.push('real OCR and inpainting execute with both remote model sources blocked');
    if(blockedOfficial){assert.ok(report.modelRequests.some(r=>r.source==='huggingface.co'));assert.ok(report.modelRequests.some(r=>['hf-mirror.com','hf-mirror.net'].includes(r.source)));report.cases.push('actual Offscreen official-source block falls back to verified mirror files');}
    auditPageErrors();assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.status='passed';
    focusGuard();
})().catch(async error=>{
    report.status='failed';report.failure=error.stack;process.exitCode=1;console.error(error);
    if(cdp){report.lastImageUi=await imageUi('return [...this.querySelectorAll(".fr-image-feedback .fr-image-status")].map(s=>s.textContent)').catch(()=>null);report.lastCanvasUi=await canvasUi('return [...this.querySelectorAll("canvas")].map(c=>({width:c.width,height:c.height,style:c.style.cssText}))').catch(()=>null);report.lastProgress=await worker.evaluate(()=>globalThis.__mangaTest.progress).catch(()=>null);}
    if(page){
        report.failureViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio})).catch(()=>null);
        if(errorRecoveryTest&&recoveryViewport&&cdp)await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true}).then(result=>fs.writeFileSync(path.join(artifacts,'failed-reader.png'),Buffer.from(result.data,'base64'))).catch(()=>{});
        else await page.screenshot({path:path.join(artifacts,'failed-reader.png')}).catch(()=>{});
    }
})
.finally(async()=>{
    report.cleanupErrors = [];
    try {
    if(worker)await worker.evaluate(()=>({operations:globalThis.__mangaTest?.operations.length,inputs:globalThis.__mangaTest?.inputs,textBatches:globalThis.__mangaTest?.textBatches,sourceRequests:globalThis.__mangaTest?.sourceRequests,transportRequests:globalThis.__mangaTest?.transportRequests})).then(data=>Object.assign(report,data)).catch(()=>{});
    if(popup&&['ru','ko'].includes(sourceLanguage))report.ocrLanguageStatus=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadImageOcrStatus'})).catch(()=>null);
    if(page&&traceReader)report.readerTrace=await page.evaluate(()=>globalThis.__readerTrace).catch(()=>null);
    if(page&&report.status==='failed')await screenshot('failure').catch(()=>{});
    if(traceLayout){
        if(worker)report.layoutResults=await worker.evaluate(()=>globalThis.__mangaTest?.layoutResults).catch(()=>[]);
        if(modelObserver)report.layoutDraws=(await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__mangaLayoutTrace',returnByValue:true}).catch(()=>({result:{value:[]}}))).result.value;
    }
    if(modelObserver && pipelineInputs)report.pipelineLast=(await modelObserver.command('Runtime.evaluate',{expression:'globalThis.__pipelineSamples',returnByValue:true}).catch(()=>({result:{value:null}}))).result.value;
    } catch (error) {report.cleanupErrors.push(`final diagnostics: ${error.message}`);}
    try {modelObserver?.close();} catch (error) {report.observerCleanupError = error.message; report.cleanupErrors.push(`observer close: ${error.message}`);}
    let closed = !launchAttempted;
    if (launched) {
        try {await launched.close(); closed = true;}
        catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    if (profile) {
        if (closed) {
            try {fs.rmSync(profile, {recursive: true, force: true});}
            catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profile;}
        } else report.retainedProfile = profile;
    }
    if (diagnosticFixture) {
        if (closed) {
            try {fs.rmSync(diagnosticFixture, {recursive: true, force: true});}
            catch (error) {report.cleanupErrors.push(`diagnostic fixture removal: ${error.message}`); report.retainedDiagnosticFixture = diagnosticFixture;}
        } else report.retainedDiagnosticFixture = diagnosticFixture;
    }
    if (report.cleanupErrors.length) {report.status = 'failed'; process.exitCode = 1;}
    report.profileRemoved=!!profile&&!fs.existsSync(profile);
    try {fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {report.reportWriteError = error.message; report.status = 'failed'; console.error(error.stack || error); process.exitCode = 1;}
    console.log(JSON.stringify({status:report.status,cases:report.cases,report:path.join(artifacts,'report.json')},null,2));
});
