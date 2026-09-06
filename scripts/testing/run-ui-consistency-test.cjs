/** 验证本轮界面一致性：复用一个隔离后台页签，避免多次创建页签抢占前台。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const arg = (name, fallback) => process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback;
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = arg('artifacts-dir', '/private/tmp/fluentread-ui-consistency');
const {chromium} = require(path.join(arg('playwright-root', ''), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', ''));
const assert = (value, message) => { if (!value) throw new Error(message); };
fs.mkdirSync(artifacts, {recursive: true});
const report = {ok: false, assertions: [], screenshots: [], consoleErrors: [], extensionDir};
(async () => {
 let launched;
 try {
  launched = await launchFocusSafePersistentContext({chromium, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ui-consistency-')), browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'], viewport: {width: 1440, height: 1000}, timeout: 30000});
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await newPageWithoutForeground(context, 30000);
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  const check = (value, message) => {assert(value, message); report.assertions.push(message);};
  const shot = async name => { const file = path.join(artifacts, name+'.png'); await page.screenshot({path: file, fullPage: false}); report.screenshots.push(file); };
  const goto = async (file, width=1440, height=1000) => {await page.setViewportSize({width, height}); await page.goto(extensionOrigin+'/'+file);};
  await goto('options.html');
  await page.locator('.settings-app').waitFor();
  const patch = async config => {
    const response = await page.evaluate(async config => { const current = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config, expected: Object.fromEntries(Object.keys(config).map(key => [key, current.value[key]])), clientId: 'ui-consistency-fixture', sequence: Date.now(), baseRevision: 0}); }, config);
    assert(response?.success, 'Fixture configuration saved: '+JSON.stringify(response));
  };
  await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, interfaceSkin: 'default'});
  await goto('popup.html',360,600);
  await page.locator('.popup-shell[data-config-ready="true"]').waitFor();
  check(await page.locator('h1').innerText() === '网页翻译', 'Popup uses one-line functional heading');
  check(await page.locator('select').count() === 0, 'Popup contains no native selects');
  const metrics = await page.evaluate(() => ({width: document.body.getBoundingClientRect().width, overflow: document.body.scrollWidth > 360, height: document.querySelector('.popup-shell').getBoundingClientRect().height, roots: ['html','body','#app'].map(selector => ({selector,height:document.querySelector(selector).getBoundingClientRect().height,minHeight:getComputedStyle(document.querySelector(selector)).minHeight})), viewport:innerHeight}));
  check(metrics.width === 360 && !metrics.overflow && metrics.height <= 560, 'Popup is 360px wide with no horizontal overflow'); report.popup = metrics;
  await page.locator('.popup-shell').screenshot({path:path.join(artifacts,'popup.png')}); report.screenshots.push(path.join(artifacts,'popup.png'));
  check(metrics.roots.every(root => Math.abs(root.height-metrics.height)<1), 'Popup HTML, body and app match content height without empty space');
  const originalVisibility = await page.evaluate(async () => (await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value.interfaceVisibility);
  await patch({interfaceVisibility:{...originalVisibility,popupQuickFeatures:false,popupFooter:false}});
  await page.waitForFunction(previous => document.querySelector('.popup-shell').getBoundingClientRect().height < previous, metrics.height);
  const compactHeight = await page.locator('.popup-shell').evaluate(el => el.getBoundingClientRect().height);
  check(compactHeight < metrics.height - 100, 'Hiding optional modules shrinks Popup by more than 100px');
  check(await page.evaluate(() => Math.abs(document.documentElement.getBoundingClientRect().height-document.querySelector('.popup-shell').getBoundingClientRect().height)<1), 'Popup root shrinks with optional modules');
  report.popup.compactHeight = compactHeight;
  await page.locator('.popup-shell').screenshot({path:path.join(artifacts,'popup-compact.png')});
  await patch({interfaceVisibility:originalVisibility});
  await page.waitForFunction(previous => Math.abs(document.querySelector('.popup-shell').getBoundingClientRect().height-previous)<1, metrics.height);
  await page.getByRole('combobox',{name:'目标语言',exact:true}).press('Enter');
  await page.locator('.el-popper.fluentread-select-popper:visible').waitFor(); await shot('popup-language'); await page.keyboard.press('Escape');
  await page.locator('.service-field').click();
  check(await page.locator('.service-picker-heading').count() === 0, 'Service menu begins with search without redundant heading');
  await shot('popup-services');
  await goto('options.html#settings-interface'); await page.locator('.settings-app').waitFor();
  check(await page.locator('.topbar h1').innerText() === '界面风格', 'Interface style navigation is renamed');
  check(await page.locator('.loading-style-option input').first().getAttribute('value') === 'ring', 'Gentle ring appears first');
  for (const query of ['lan','language','语言','語言','言語','언어','langue','idioma','язык']) {
    await page.locator('.search-box input').fill(query);
    check((await page.locator('.search-results button').first().innerText()).includes('Language'), 'Language recovery search: '+query);
  }
  await page.locator('.search-results button').first().click();
  await page.locator('[data-testid="ui-language-select"] input').waitFor();
  check(await page.locator('[data-testid="ui-language-select"] input').evaluate(el => el === document.activeElement), 'Search focuses interface-language control');
  for (const section of ['settings-harness','settings-image-translation','settings-area-translation','settings-video','settings-glossary']) {
    await page.locator(`button[data-section="${section}"]`).click();
    const card = page.locator(`#${section} .feature-enable-card`).first(); await card.waitFor();
    const toggle = card.getByRole('switch');
    const before = await toggle.getAttribute('aria-checked'); await toggle.click();
    check(await toggle.getAttribute('aria-checked') !== before, 'Master control toggles: '+section);
    await shot(section+'-enabled');
    await toggle.click();
  }
  await page.locator('button[data-section="settings-video"]').click();
  await page.locator('[data-video-subtitle-appearance]').scrollIntoViewIfNeeded();
  for (const skin of ['classic','clean','glass','contrast','paper','terminal','neon','minimal']) {
    const radio = page.locator(`.subtitle-skin-option[data-skin="${skin}"]`);
    if (!await radio.count()) continue;
    await radio.click();
    const colors = await page.locator('[data-video-subtitle-preview]').evaluate(el => ({source: getComputedStyle(el.querySelector('span')).color, translation: getComputedStyle(el.querySelector('b')).color, paint: getComputedStyle(el.querySelector('span')).paintOrder}));
    check(colors.paint === 'stroke', 'Subtitle preview paints text over stroke: '+skin);
    report['subtitle-'+skin] = colors;
    await shot('subtitle-'+skin);
  }
  for (const section of ['settings-glossary','settings-translation-center','settings-model-usage','settings-vocabulary']) {
    const nav = page.locator(`button[data-section="${section}"]`); if (!await nav.count()) continue;
    await nav.click();
    check(await page.locator(`#${section} select`).count() === 0, 'No native select in '+section);
    if (section === 'settings-translation-center') {
      await page.locator('.translation-center-service-picker > button').click();
      check(await page.locator('.service-picker-search').evaluate(el=>el.getBoundingClientRect().height)>=44,'Translation center service search retains 44px height');
      await shot('translation-center-services');await page.locator('.service-picker-close').click();
    }
    if (section === 'settings-glossary') {
      const select = page.getByRole('combobox',{name:'源语言',exact:true}).last();
      await select.scrollIntoViewIfNeeded(); await select.press('Enter'); await page.locator('.el-popper.fluentread-select-popper:visible').waitFor(); await shot('glossary-menu'); await page.keyboard.press('Escape');
    }
  }
  await goto('options.html#settings-video'); await page.locator('.video-model-card').first().waitFor();
  const modelProof = await page.evaluate(async () => {
    const tiny='https://modelscope.cn/models/onnx-community/whisper-tiny/resolve/master/onnx/encoder_model_q4.onnx';
    const base='https://modelscope.cn/models/onnx-community/whisper-base/resolve/master/config.json';
    const cache=await caches.open('transformers-cache');await cache.put(tiny,new Response('fixture-tiny'));await cache.put(base,new Response('fixture-base'));
    await chrome.storage.local.set({fluentReadVideoLocalTranscriptionModels:['tiny','base']});
    return {tiny,base};
  });
  await page.reload(); await page.getByRole('button',{name:/清除 Whisper Tiny/}).click();
  await page.waitForFunction(async () => !await (await caches.open('transformers-cache')).match('https://modelscope.cn/models/onnx-community/whisper-tiny/resolve/master/onnx/encoder_model_q4.onnx'));
  check(await page.evaluate(async ({base}) => Boolean(await (await caches.open('transformers-cache')).match(base)),modelProof), 'Clearing Tiny through UI retains Base cache');
  check((await page.locator('.video-model-size').allTextContents()).join(' ').includes('100 MB'), 'Whisper cards show estimated download sizes');
  await shot('video-models');
  const ocrProof = await page.evaluate(async () => {
    const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('keyval-store');r.onupgradeneeded=()=>r.result.createObjectStore('keyval');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    await new Promise(resolve=>{const tx=database.transaction('keyval','readwrite');tx.objectStore('keyval').put('fixture-eng','fluent-read-image-ocr/eng.traineddata');tx.objectStore('keyval').put('fixture-jpn','fluent-read-image-ocr/jpn.traineddata');tx.oncomplete=resolve});
    const response=await chrome.runtime.sendMessage({type:'fluentReadImageOcrRemove',languages:['eng']});
    const keys=await new Promise(resolve=>{const r=database.transaction('keyval').objectStore('keyval').getAllKeys();r.onsuccess=()=>resolve(r.result)});database.close();return {response,keys};
  });
  check(ocrProof.response.success && !ocrProof.keys.includes('fluent-read-image-ocr/eng.traineddata') && ocrProof.keys.includes('fluent-read-image-ocr/jpn.traineddata'), 'Production OCR clear removes selected files and retains other languages');
  await goto('document.html');
  await page.locator('.document-app').waitFor();
  check(await page.locator('.document-header .ui-language-selector').count() === 0, 'Document header has no interface-language selector');
  await page.locator('input[type="file"]').setInputFiles({name:'sample.md', mimeType:'text/markdown', buffer:Buffer.from('# Example\n\nThis is a document for translation.\n\nAnother paragraph.')});
  await page.getByRole('combobox',{name:'文档目标语言'}).waitFor();
  check(await page.locator('select').count() === 0, 'Document has no native selects');
  await page.getByRole('combobox',{name:'文档目标语言'}).press('Enter');
  await page.locator('.el-popper.fluentread-select-popper:visible').waitFor(); await shot('document-language');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.emulateMedia({colorScheme:'dark'});
  await page.getByRole('combobox',{name:'文档翻译服务'}).press('Enter'); await shot('document-dark-menu'); await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Document narrow layout has no horizontal overflow'); await shot('document-mobile');
  await patch({videoTranslationEnabled:true});
  const fixtureUrl='https://x.com/fluentread-ui-fixture/status/1';
  await context.route(fixtureUrl, route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body style="margin:24px"><article><div data-testid="videoPlayer" style="position:relative;width:640px;height:360px;background:#152535"><video style="width:100%;height:100%" poster="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22640%22 height=%22360%22/%3E"></video></div></article></body></html>'}));
  await page.setViewportSize({width:1000,height:700});await page.goto(fixtureUrl);
  await page.locator('video').hover();
  await page.evaluate(()=>{window.xPlacementSamples=[];window.xPlacementObserver=new MutationObserver(()=>{for(const button of document.querySelectorAll('.fluent-read-video-subtitle-button'))window.xPlacementSamples.push({parent:button.parentElement.className,first:button.parentElement.firstElementChild===button})});window.xPlacementObserver.observe(document.body,{childList:true,subtree:true})});
  await page.waitForTimeout(400);
  check(await page.locator('.fluent-read-video-subtitle-button').count()===0,'X waits for delayed native controls without a corner icon');
  const mountControls=()=>page.evaluate(()=>{const row=document.createElement('div');row.className='fixture-controls';row.style.cssText='position:absolute;bottom:0;left:0;right:0;display:flex;height:44px;align-items:center';row.innerHTML='<button aria-label="Play">▶</button><span>0:00 / 0:54</span><button aria-label="Settings">Settings</button><button aria-label="Fullscreen">Fullscreen</button>';document.querySelector('[data-testid="videoPlayer"]').appendChild(row)});
  await mountControls();await page.locator('.fixture-controls .fluent-read-video-subtitle-button').waitFor();
  await page.locator('.fixture-controls').evaluate(el=>el.remove());await page.waitForTimeout(150);
  await mountControls();await page.locator('.fixture-controls .fluent-read-video-subtitle-button').waitFor();
  const placements=await page.evaluate(()=>{window.xPlacementObserver.disconnect();return window.xPlacementSamples});
  check(placements.length>0 && placements.every(sample=>sample.parent==='fixture-controls' && sample.first),'X first appearance and remount stay at the left of native controls');
  report.xFixture={url:fixtureUrl,placements};await shot('x-controls');
  check(report.consoleErrors.length === 0, 'No unhandled browser errors');
  report.ok = true;
 } catch(error) { report.error = error.stack || String(error); throw error; }
 finally { fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)); await launched?.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
