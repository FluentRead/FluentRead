#!/usr/bin/env node
// 使用生产扩展和隔离浏览器验证字幕、缓存、设置、圈选与导航；站点及翻译服务使用受控夹具。
// 不下载 OCR/Whisper 模型；圈选下载续接由组件测试覆盖。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-reported-fixes-proof'));
const mediaInput = arg('media-dir');
if (!mediaInput) throw new Error('Pass --media-dir containing video-direct.mp4 from run-x-subtitle-sync-test.cjs');
const mediaDir = path.resolve(mediaInput);
const runtime = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
const browserPath = arg('browser-path', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const extensionInstall = arg('extension-install', 'cdp');
if (!runtime || !helperPath) throw new Error('Explicit Playwright runtime and focus-safe helper are required');
const {chromium} = createRequire(path.join(runtime, 'x-native-proof.cjs'))('playwright');
const helper = require(path.resolve(helperPath));
const fixtureUrl = 'https://x.com/cerebras';
const mediaUrl = 'https://video.twimg.com/ext_tw_video/424242/pu/video-direct.mp4';
fs.mkdirSync(artifacts, {recursive: true});
if (!fs.existsSync(path.join(mediaDir, 'video-direct.mp4'))) throw new Error(`Native fixture media is missing: ${mediaDir}`);

const report = {
  fixtureUrl,
  mediaUrl,
  nativeTrack: true,
  errors: [],
  console: [],
  screenshots: [],
};
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-reported-fixes-profile-'));
let browser;
let page;
let control;

async function persistConfig(controlPage, fontScale = 100, appearanceOverrides = {}) {
  return controlPage.evaluate(async ({fontScale, appearanceOverrides}) => {
    const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!read?.success) throw new Error(`configStorageRead failed: ${JSON.stringify(read)}`);
    const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value || {};
    return chrome.runtime.sendMessage({
      type: 'persistConfig', clientId: 'x-native-subtitle-proof', sequence: Date.now(),
      config: {
        ...current, on: true, from: 'en', videoSourceLanguage: 'auto', to: 'zh-Hans',
        videoTranslationEnabled: true, videoSubtitleVisible: true,
        videoSubtitleDisplayMode: 'bilingual', videoService: 'microsoft',
        videoServiceDefaultMigrated: true, useCache: false,
        videoSubtitleAppearance: {
          ...(current.videoSubtitleAppearance || {}), skin: 'clean', textColor: '#1f2937',
          translationColor: '#0f766e', backgroundOpacity: 88, fontScale,
          position: 'top', maxWidth: 78, ...appearanceOverrides,
        },
      },
      ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision: current.__fluentConfigRevision} : {}),
    });
  }, {fontScale, appearanceOverrides});
}

async function waitForNativeText(pageRef, expected) {
  await pageRef.waitForFunction((text) => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === text, expected, {timeout: 10000});
}

async function screenshot(pageRef, name) {
  const target = path.join(artifacts, `${name}.png`);
  await pageRef.screenshot({path: target});
  report.screenshots.push(target);
}

async function main() {
  const videoBytes = fs.readFileSync(path.join(mediaDir, 'video-direct.mp4'));
  browser = await helper.launchFocusSafePersistentContext({
    chromium,
    profileDir,
    browserPath,
    headless: false,
    background: true,
    displayTarget: 'secondary',
    browserArgs: [
      ...(extensionInstall === 'cdp'
        ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]),
      '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    ],
    viewport: {width: 1280, height: 900},
  });
  const context = browser.context;
  context.setDefaultTimeout(15000);
  report.browserVersion = context.browser().version();
  report.browserPath = browserPath;
  let extensionId;
  if (extensionInstall === 'cdp') {
    const extensionSession = await context.browser().newBrowserCDPSession();
    extensionId = (await extensionSession.send('Extensions.loadUnpacked', {path: extensionDir})).id;
    await extensionSession.detach();
  }
  report.extensionInstall = extensionInstall;
  context.on('page', candidate => {
    candidate.on('pageerror', error => report.errors.push(error.message));
    candidate.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') report.console.push(message.text());
    });
  });
  const workerPredicate = candidate => extensionId
    ? new URL(candidate.url()).host === extensionId
    : candidate.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(workerPredicate)
    || await context.waitForEvent('serviceworker', {predicate: workerPredicate, timeout: 30000});
  extensionId ||= new URL(worker.url()).host;
  report.extensionId = extensionId;
  await worker.evaluate(() => {
    globalThis.proofAsrCalls = 0;
    globalThis.proofPrepareCalls = 0;
    globalThis.proofTranslationCalls = 0;
    globalThis.proofTranslationSources = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'fluentReadTranscribeLocalVideoAudio') globalThis.proofAsrCalls += 1;
      if (message?.type === 'fluentReadPrepareLocalVideoModel') globalThis.proofPrepareCalls += 1;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url || input);
      if (!url.startsWith('https://edge.microsoft.com/translate/translatetext')) return originalFetch(input, init);
      globalThis.proofTranslationCalls += 1;
      const source = JSON.parse(init.body)[0];
      globalThis.proofTranslationSources.push(source);
      return new Response(JSON.stringify([{translations: [{text: `译文：${source}`}]}]), {
        status: 200, headers: {'content-type': 'application/json'},
      });
    };
  });

  control = await helper.newPageWithoutForeground(context);
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
  await control.waitForTimeout(300);
  const configResult = await persistConfig(control);
  assert.equal(configResult?.success, true, JSON.stringify(configResult));

  await context.route('https://video.twimg.com/**', async route => {
    const requested = new URL(route.request().url());
    if (requested.pathname.endsWith('/video-direct.mp4')) {
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(videoBytes.length - 1, range[2] ? Number(range[2]) : videoBytes.length - 1);
        await route.fulfill({status: 206, contentType: 'video/mp4', headers: {
          'access-control-allow-origin': '*', 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${videoBytes.length}`,
        }, body: videoBytes.subarray(start, end + 1)});
        return;
      }
      await route.fulfill({status: 200, contentType: 'video/mp4', headers: {'access-control-allow-origin': '*', 'accept-ranges': 'bytes'}, body: videoBytes});
      return;
    }
    await route.abort();
  });
  await context.route(fixtureUrl, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:24px;background:#f3f5f9"><h1>X native subtitle fixture</h1><article><a href="/cerebras/status/2089870131291943228/video/1">View media</a><div data-testid="videoPlayer" style="position:relative;width:960px;height:540px;background:#10283f"><video style="width:100%;height:100%"></video><div class="fixture-controls" style="position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:flex-end;background:#222"><button aria-label="Settings">Settings</button><button>Fullscreen</button></div></div></article></body></html>`,
  }));
  page = await helper.newPageWithoutForeground(context);
  await page.goto(fixtureUrl);
  await page.evaluate(media => {
    const video = document.querySelector('video');
    video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/424242/pu/img/fixture.jpg';
    const native = video.addTextTrack('captions', 'Korean', 'ko');
    native.addCue(new VTTCue(0, 1.4, '<X-word-ms ms=419,60,340 index=1 character_ranges=0-7,8-10,11-13>오늘은 좋은 날입니다.</X-word-ms>'));
    native.addCue(new VTTCue(2.7, 5.1, '&lt;X-word-ms ms=419 index=1&gt;커피를 마시고 친구를 만났습니다.&lt;/X-word-ms&gt;'));
    native.addCue(new VTTCue(6.4, 8.65, '<v Speaker><b>내일은 함께 공원에 가려고 합니다.</b></v>'));
    native.mode = 'showing';
    const alternative = video.addTextTrack('captions', 'French', 'fr');
    alternative.addCue(new VTTCue(0, 1.2, 'French native fixture'));
    alternative.mode = 'disabled';
    window.proofNativeTrack = native;
    video.src = media;
    video.load();
  }, mediaUrl);
  await page.locator('video').hover();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, {timeout: 15000});
  await page.waitForSelector('#fluent-read-video-subtitle-button', {timeout: 15000});
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-menu')?.hidden);
  await screenshot(page, 'native-menu');

  const seek = async time => page.evaluate(value => {
    const video = document.querySelector('video');
    video.currentTime = value;
  }, time);
  await seek(0.5);
  await page.waitForFunction(time => Math.abs(document.querySelector('video').currentTime - time) < 0.1, 0.5);
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('timeupdate')));
  await waitForNativeText(page, '오늘은 좋은 날입니다.');
  report.captionSource = await page.locator('#fluent-read-video-ai-caption-container').getAttribute('data-fluent-read-caption-source');
  report.nativeCueCount = await page.evaluate(() => document.querySelector('video').textTracks[0].cues?.length || 0);
  assert.ok(report.captionSource === 'native' || report.captionSource === 'sidecar', `unexpected native caption source: ${report.captionSource}`);
  assert.equal(report.nativeCueCount, 3, 'the fixture exposes three native VTTCue entries');
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[0].mode), 'hidden');
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[1].mode), 'hidden');
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent?.includes('译文：'));
  assert.match(await page.locator('#fluent-read-video-subtitle-original').textContent(), /[가-힣]/u);

  report.buttonOrder = await page.locator('.fixture-controls').evaluate(node => [...node.children].map(child => child.id || child.textContent));
  assert.equal(report.buttonOrder.at(-1), 'fluent-read-video-subtitle-button');
  for (const mode of ['translation-only', 'original-only', 'bilingual']) {
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.waitForTimeout(180);
    const state = await page.evaluate(() => ({
      original: getComputedStyle(document.querySelector('#fluent-read-video-subtitle-original')).display,
      translation: getComputedStyle(document.querySelector('#fluent-read-video-subtitle')).visibility,
    }));
    if(mode === 'translation-only') assert.equal(state.original, 'none');
    else assert.notEqual(state.original, 'none');
    if(mode === 'original-only') assert.equal(state.translation, 'hidden');
    else assert.equal(state.translation, 'visible');
    report[mode] = state;
    await screenshot(page, mode);
  }
  const cache = await control.evaluate(async () => {
    const request = {source: {poster:'https://pbs.twimg.com/ext_tw_video_thumb/515151/pu/img/fixture.jpg'}, model:'tiny', videoSourceLanguage:'auto'};
    const set = await chrome.runtime.sendMessage({type:'fluentReadSetVideoAiSubtitleCache', ...request, cues:[{startMs:0,durationMs:10000,text:'Cached video transcript without another recognition.'}]});
    const get = await chrome.runtime.sendMessage({type:'fluentReadGetVideoAiSubtitleCache', ...request});
    const stats = await chrome.runtime.sendMessage({type:'fluentReadGetVideoAiSubtitleCacheStats'});
    return {set,get,stats};
  });
  assert.equal(cache.set.cached,true); assert.equal(cache.get.hit,true); assert.equal(cache.stats.stats.entries,1);
  await page.reload();
  await page.evaluate(media => {
    const video = document.querySelector('video');
    video.poster='https://pbs.twimg.com/ext_tw_video_thumb/515151/pu/img/fixture.jpg';video.src=media;video.load();
  }, mediaUrl.replace('424242','515151'));
  await waitForNativeText(page,'Cached video transcript without another recognition.');
  assert.equal(await worker.evaluate(() => globalThis.proofAsrCalls),0);
  report.cache = cache;
  await screenshot(page,'cache-restored');


  const optionsPage=await helper.newPageWithoutForeground(context);
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.waitForSelector('[data-section="settings-model-usage"]');
  const usageImport=await optionsPage.evaluate(async()=>{
    const now=Date.now();
    return chrome.runtime.sendMessage({type:'modelUsage',action:'import',document:{format:'fluentread-model-usage',version:1,exportedAt:now,events:[{
      id:'reported-fixes-usage',schemaVersion:1,startedAt:now,durationMs:1500,serviceId:'openai',configuredModel:'fixture-model',purpose:'translation',outcome:'success',usageAvailability:'reported',inputTokens:56500,outputTokens:3200,totalTokens:59700,cachedInputTokens:28000
    }]}});
  });
  assert.equal(usageImport.success,true,JSON.stringify(usageImport));
  await optionsPage.evaluate(async()=>{
    const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
    const current=typeof read.value==='string'?JSON.parse(read.value):read.value;
    await chrome.runtime.sendMessage({type:'persistConfig',clientId:'reported-fixes-language',sequence:Date.now(),config:{...current,uiLanguage:'en-US'},baseRevision:current.__fluentConfigRevision});
  });
  await optionsPage.locator('[data-section="settings-model-usage"]').click();
  await optionsPage.waitForFunction(()=>document.body.innerText.includes('59.7K'));
  report.modelUsage=await optionsPage.locator('.model-usage-dashboard').innerText().catch(()=>optionsPage.locator('main').innerText());
  assert.ok(!/[万亿]/u.test(report.modelUsage));
  await screenshot(optionsPage,'model-usage-english');
  await optionsPage.evaluate(async()=>{
    const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
    const current=typeof read.value==='string'?JSON.parse(read.value):read.value;
    await chrome.runtime.sendMessage({type:'persistConfig',clientId:'reported-fixes-chinese',sequence:Date.now(),config:{...current,uiLanguage:'zh-CN'},baseRevision:current.__fluentConfigRevision});
  });
  await optionsPage.locator('[data-section="settings-services"]').click();
  const minimax=optionsPage.locator('[data-service-value="minimax"]');
  // 服务目录中的 AI 分组可能默认折叠。
  if (!(await minimax.isVisible())) await optionsPage.locator('[data-service-section-toggle="ai"]').click();
  await minimax.click();
  const advanced=optionsPage.locator('[data-testid="custom-service-advanced"]');
  const endpoint=optionsPage.locator('[data-minimax-endpoint]');
  await endpoint.waitFor();
  assert.equal(await advanced.getAttribute('open'),null);
  assert.equal(await optionsPage.locator('.service-connection-section input[placeholder*=thinking]').count(),1);
  assert.equal(await optionsPage.locator('.service-connection-section input[placeholder*=thinking]').isVisible(),false);
  await screenshot(optionsPage,'minimax-collapsed');
  await advanced.locator('summary').click();
  assert.equal(await optionsPage.locator('.service-connection-section input[placeholder*=thinking]').isVisible(),true);
  await screenshot(optionsPage,'minimax-advanced');
  await optionsPage.setViewportSize({width:820,height:900});
  await endpoint.scrollIntoViewIfNeeded();
  assert.equal(await optionsPage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await screenshot(optionsPage,'minimax-narrow');
  await optionsPage.setViewportSize({width:1280,height:900});
  report.serviceLayout={singleCustomBody:true,collapsedHidden:true,narrowNoOverflow:true};
  await control.evaluate(async () => {
    const read = await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
    const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
    await chrome.runtime.sendMessage({type:'persistConfig',clientId:'reported-fixes',sequence:Date.now(),config:{...current,service:'microsoft',translationMode:'bilingual',selectionAreaEnabled:true,on:true},baseRevision:current.__fluentConfigRevision});
  });
  const articleUrl='https://help.buymeacoffee.com/en/articles/8039657-understanding-the-tax-process-on-buy-me-a-coffee';
  const html=`<!doctype html><html lang="en"><body style="font:20px Arial;max-width:800px;margin:40px"><h1>Understanding the tax process</h1><p>When you receive support, this article explains how the process works and where to find more information.</p><p>The research team reviewed the results before preparing a detailed report for the next meeting.</p><a id="navigate" href="/en/articles/next-fixture">Read the next article</a><button id="cancel">Cancel navigation</button><button id="spa">Open related article</button><script>document.querySelector('#cancel').onclick=e=>e.preventDefault();document.querySelector('#spa').onclick=()=>{history.pushState({},'', '?related=1');setTimeout(()=>{document.querySelector('p').textContent='A new related article replaces this paragraph after the navigation has completed.'},700)}</script></body></html>`;
  await context.route(articleUrl, route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  let pendingNavigation=false;
  let releaseNavigation; const navigationGate=new Promise(resolve=>{releaseNavigation=resolve;});
  const gateTimeout=setTimeout(()=>releaseNavigation(),5000);
  await context.route('**/en/articles/next-fixture',async route=>{pendingNavigation=true;await navigationGate;await route.fulfill({status:200,contentType:'text/html',body:'<h1>The next article</h1><p>Navigation completed.</p>'});});
  const navigationPage=await helper.newPageWithoutForeground(context);
  const navigationSamples=[];
  navigationPage.on('console', message=>{if(message.text().startsWith('fr-nav-sample:')) navigationSamples.push({at:Date.now(),...JSON.parse(message.text().slice(14))});});
  await navigationPage.goto(articleUrl);
  await navigationPage.waitForTimeout(400);

  await worker.evaluate(async url=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===url);if(!tab)throw new Error('Missing isolated fixture tab');await chrome.tabs.update(tab.id,{active:true});},articleUrl);
  await navigationPage.keyboard.press('Shift+z');
  await navigationPage.mouse.move(80,110);await navigationPage.mouse.down();await navigationPage.mouse.move(500,230);await navigationPage.mouse.up();
  // 圈选结果使用 closed ShadowRoot，使用 CDP pierce 读取，保持生产隔离边界。
  const areaSession=await context.newCDPSession(navigationPage);
  const findPrepare=node=>{
    const children=[...(node.children||[]),...(node.shadowRoots||[])];
    if(node.nodeName==='BUTTON' && children.some(child=>child.nodeValue==='下载语言包并重试')) return node;
    for(const child of children){const found=findPrepare(child);if(found)return found;}
    return null;
  };
  let prepareNode;
  for(let attempt=0;attempt<30 && !prepareNode;attempt++) {
    await navigationPage.waitForTimeout(200);
    prepareNode=findPrepare((await areaSession.send('DOM.getDocument',{depth:-1,pierce:true})).root);
  }
  await screenshot(navigationPage,'area-download-action');
  assert.ok(prepareNode,'closed area UI must offer one-click language download');
  const prepareBox=await areaSession.send('DOM.getBoxModel',{backendNodeId:prepareNode.backendNodeId});
  assert.ok(prepareBox.model.width>0 && prepareBox.model.height>0);
  await areaSession.detach();
  report.areaRecoveryButton=true;
  await navigationPage.keyboard.press('Escape');
  await navigationPage.keyboard.press('Alt+t');
  await navigationPage.waitForFunction(()=>document.querySelectorAll('.fluent-read-bilingual-content').length>=2,null,{timeout:15000});
  await navigationPage.evaluate(()=>{window.proofCounts=[];const sample=()=>window.proofCounts.push(document.querySelectorAll('.fluent-read-bilingual-content').length);new MutationObserver(sample).observe(document.body,{subtree:true,childList:true,attributes:true});sample();});
  await navigationPage.locator('#cancel').click();await navigationPage.waitForTimeout(150);
  assert.ok(await navigationPage.locator('.fluent-read-bilingual-content').count()>=2);
  await navigationPage.locator('#spa').click();await navigationPage.waitForTimeout(200);
  assert.ok(await navigationPage.locator('.fluent-read-bilingual-content').count()>=2);
  await navigationPage.waitForTimeout(650);
  await screenshot(navigationPage,'navigation-bilingual');
  await navigationPage.evaluate(()=>{setInterval(()=>console.log('fr-nav-sample:'+JSON.stringify({href:location.href,count:document.querySelectorAll('.fluent-read-bilingual-content').length})),40);});
  const navigationStarted=Date.now();
  const navigation=navigationPage.locator('#navigate').click({noWaitAfter:true});
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(pendingNavigation,true);
  const pendingSamples=navigationSamples.filter(sample=>sample.at>=navigationStarted);
  report.navigation={fixture:true,samples:pendingSamples};
  releaseNavigation(); clearTimeout(gateTimeout); await navigation;
  assert.ok(pendingSamples.length>=2,'must observe the old page while the next response is held');
  assert.ok(pendingSamples.every(sample=>sample.count>=2),'translated page must remain visible until navigation commits');
  await navigationPage.waitForURL('**/next-fixture');
  Object.assign(report,await worker.evaluate(()=>({asrCalls:globalThis.proofAsrCalls,prepareCalls:globalThis.proofPrepareCalls,translationCalls:globalThis.proofTranslationCalls})));
  report.launchMode=browser.launchMode;report.focusPolicy=browser.focusPolicy;report.windowPlacement=browser.windowPlacement;
  assert.equal(report.windowPlacement.browserFrontmost,false);
  report.success=true;
}
main().catch(async error=>{report.failure=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:report.success,failure:report.failure,artifacts},null,2));if(browser)await browser.close();fs.rmSync(profileDir,{recursive:true,force:true});});
