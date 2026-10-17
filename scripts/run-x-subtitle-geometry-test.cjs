#!/usr/bin/env node
'use strict';

// X-like local fixture geometry regression. This proves production extension
// DOM behavior only; it does not exercise live X, ASR, or a real provider.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-x-portrait-proof'));
const browserPath = arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
if (!playwrightRoot || !helperPath) throw new Error('必须传入 --playwright-root 和 --focus-safe-helper');
if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`找不到扩展构建：${extensionDir}`);
fs.mkdirSync(artifacts, {recursive: true});
const {chromium} = createRequire(path.join(path.resolve(playwrightRoot), 'x-portrait-geometry.cjs'))('playwright');
const helper = require(path.resolve(helperPath));
let profileDir, mediaDir, videoPath, videoBytes;

function run(program, args) {
  const result = spawnSync(program, args, {encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL'});
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.stdout}`);
}


const fixtureUrl = 'https://x.com/cerebras/status/2089870131291943228';
const youtubeUrl = 'https://www.youtube.com/watch?v=fluentread-portrait-compat';
const sourceText = 'ThisIsAnExtremelyLongUnbrokenEnglishSubtitleThatMustWrapInsideThePortraitVideoContentRectWithoutEscapingTheLayerBounds';
const translatedText = '这是一条非常长的中文字幕，用来验证竖屏画面区域内的换行与裁剪边界。';
const report = {
  fixture: 'local-x-like-production-browser',
  fixtureUrl,
  media: {width: 360, height: 640, durationSeconds: 3, audio: 'none'},
  evidenceLimits: ['local route only', 'mock Microsoft translation response', 'no ASR', 'no live X or external provider'],
  cases: [], errors: [], console: [], requests: [],
  launchMode: null,
  focusPolicy: null,
  windowPlacement: null,
};

function geometrySnapshot(page, phase) {
  return page.evaluate((phaseName) => {
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value ? {left:value.left, top:value.top, right:value.right, bottom:value.bottom, width:value.width, height:value.height} : null;
    };
    const button = document.querySelector('#fluent-read-video-subtitle-button');
    const menu = document.querySelector('#fluent-read-video-subtitle-menu');
    const player = document.querySelector('[data-testid="videoPlayer"]');
    const video = document.querySelector('video');
    const layer = document.querySelector('#fluent-read-video-subtitle-layer');
    const panel = document.querySelector('#fluent-read-video-subtitle-panel');
    const original = document.querySelector('#fluent-read-video-subtitle-original');
    const translation = document.querySelector('#fluent-read-video-subtitle');
    const controls = player?.querySelector('.ytp-right-controls');
    const style = layer ? getComputedStyle(layer) : null;
    const controlsStyle = controls ? getComputedStyle(controls) : null;
    const originalStyle = original ? getComputedStyle(original) : null;
    const translationStyle = translation ? getComputedStyle(translation) : null;
    return {
      phase: phaseName,
      player: rect(player), video: rect(video), layer: rect(layer), panel: rect(panel),
      original: rect(original), translation: rect(translation), controls: rect(controls),
      originalVisible: Boolean(original && originalStyle?.display !== 'none' && originalStyle?.visibility !== 'hidden' && originalStyle?.opacity !== '0'),
      translationVisible: Boolean(translation && translationStyle?.display !== 'none' && translationStyle?.visibility !== 'hidden' && translationStyle?.opacity !== '0'),
      controlsVisible: Boolean(controls && controlsStyle?.display !== 'none' && controlsStyle?.visibility !== 'hidden' && controlsStyle?.opacity !== '0'),
      source: document.querySelector('#fluent-read-video-ai-caption-container')?.dataset.fluentReadCaptionSource || '',
      originalText: original?.textContent?.trim() || '', translationText: translation?.textContent?.trim() || '',
      layerClipPath: style?.clipPath || '', layerOverflow: style?.overflow || '',
      originalWrap: originalStyle?.overflowWrap || '', translationWrap: translationStyle?.overflowWrap || '',
      originalFits: Boolean(original && original.scrollWidth <= original.clientWidth + 1),
      translationFits: Boolean(translation && translation.scrollWidth <= translation.clientWidth + 1),
      button: String(Boolean(button?.classList.contains('fluent-read-video-subtitle-active'))),
      menuButton: button ? {role: button.getAttribute('role'), hasPopup: button.getAttribute('aria-haspopup'),
        controls: button.getAttribute('aria-controls'), expanded: button.getAttribute('aria-expanded'),
        pressed: button.getAttribute('aria-pressed'), menuHidden: menu ? menu.hidden : null} : null,
      fullscreen: Boolean(document.fullscreenElement),
    };
  }, phase);
}

async function main() {
  let browserSession;
  let control;
  let page;
  let launchAttempted = false;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-x-portrait-'));
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-x-portrait-media-'));
    videoPath = path.join(mediaDir, 'portrait.mp4');

    run('/opt/homebrew/bin/ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x17212b:s=360x640:r=24', '-t', '3',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', videoPath,
    ]);
    videoBytes = fs.readFileSync(videoPath).toString('base64');
    launchAttempted = true;
    browserSession = await helper.launchFocusSafePersistentContext({
      chromium, profileDir, browserPath, headless: false, background: true,
      displayTarget: 'secondary',
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
      viewport: {width: 1280, height: 900},
    });
    const context = browserSession.context;
    report.launchMode = browserSession.launchMode;
    report.focusPolicy = browserSession.focusPolicy;
    report.windowPlacement = browserSession.windowPlacement;
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement?.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement?.browserFrontmost, false);
    report.browserVersion = context.browser().version();
    report.browserPath = browserPath;
    const workers = () => context.serviceWorkers().filter(worker => worker.url().endsWith('/background.js'));
    const worker = workers()[0] || await context.waitForEvent('serviceworker', {predicate: candidate => candidate.url().endsWith('/background.js'), timeout: 30000});
    report.extensionId = new URL(worker.url()).host;
    context.on('page', candidate => {
      candidate.on('pageerror', error => report.errors.push(error.stack || error.message));
      candidate.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') report.console.push(message.text());
      });
    });
    await worker.evaluate((mockTranslation) => {
      globalThis.xPortraitTranslationRequests = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input?.url || input);
        if (!url.startsWith('https://edge.microsoft.com/translate/translatetext')) return originalFetch(input, init);
        const body = JSON.parse(init?.body || '[]');
        const source = String(body?.[0] || '');
        globalThis.xPortraitTranslationRequests.push(source);
        return new Response(JSON.stringify([{translations: [{text: `译文：${mockTranslation}`}]}]), {status: 200, headers: {'content-type': 'application/json'}});
      };
    }, translatedText);
    const activate = target => helper.activateExtensionTabWithoutForeground({serviceWorkers: () => [worker]}, target);
    control = await helper.newPageWithoutForeground(context);
    await control.goto(`chrome-extension://${report.extensionId}/popup.html`, {waitUntil: 'domcontentloaded'});
    const persisted = await control.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type:'configStorageRead', key:'local:config'});
      const current = typeof read?.value === 'string' ? JSON.parse(read.value) : (read?.value || {});
      return chrome.runtime.sendMessage({type:'persistConfig', clientId:'x-portrait-geometry', sequence:1, config:{...current, on:true, from:'en', to:'zh-Hans', videoTranslationEnabled:true, videoService:'microsoft', videoServiceDefaultMigrated:true, videoSubtitleVisible:true, videoSubtitleDisplayMode:'bilingual', useCache:false}, ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision:current.__fluentConfigRevision} : {})});
    });
    assert.equal(persisted?.success, true, `配置保存失败：${JSON.stringify(persisted)}`);

    page = await helper.newPageWithoutForeground(context);
    await page.route(fixtureUrl, route => route.fulfill({status:200, contentType:'text/html', body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X portrait subtitle geometry fixture</title><style>html,body{margin:0;background:#eef1f5}body{padding:24px;font:16px Arial,sans-serif}article{width:720px}#player{position:relative;width:720px;height:640px;background:#05080b;overflow:hidden}#video{position:absolute;left:180px;top:0;width:360px;height:640px;object-fit:contain;background:#17212b}.ytp-right-controls{position:absolute;right:18px;bottom:14px;display:flex;gap:8px;align-items:center;height:44px;z-index:20}.ytp-right-controls button{height:36px;background:#27384a;color:#fff;border:0;padding:0 10px}.fixture-hidden .ytp-right-controls{opacity:0;pointer-events:none}</style></head><body><article><div id="player" data-testid="videoPlayer"><video id="video" controls playsinline preload="auto"></video><div class="ytp-right-controls"><button aria-label="Settings">Settings</button><button id="fullscreen" aria-label="Fullscreen">Fullscreen</button></div></div></article><script>document.getElementById('fullscreen').addEventListener('click',()=>document.getElementById('player').requestFullscreen?.())</script></body></html>`}), {times:1});
    await page.goto(fixtureUrl, {waitUntil:'domcontentloaded'});
    await activate(page);
    await page.evaluate((base64) => {
      const video = document.querySelector('video');
      video.src = `data:video/mp4;base64,${base64}`;
      video.load();
      const track = video.addTextTrack('captions', 'English', 'en');
      track.addCue(new VTTCue(0, 3, 'ThisIsAnExtremelyLongUnbrokenEnglishSubtitleThatMustWrapInsideThePortraitVideoContentRectWithoutEscapingTheLayerBounds'));
      track.mode = 'showing';
      window.__portraitTrack = track;
      video.currentTime = 0.5;
      video.play().then(() => setTimeout(() => video.pause(), 120)).catch(() => {});
    }, videoBytes);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, {timeout: 15000});
    await page.evaluate(() => {
      const video = document.querySelector('video');
      const track = video.addTextTrack('captions', 'English', 'en');
      track.addCue(new VTTCue(0, 3, 'YouTube native caption remains visible.'));
      track.mode = 'showing';
      video.currentTime = 0.4;
    });
    await page.locator('video').hover();
    await page.waitForSelector('#fluent-read-video-subtitle-button', {timeout: 15000});
    await page.waitForTimeout(1200);
    await page.locator('#fluent-read-video-subtitle-button').click();
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === false, null, {timeout: 10000});
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent?.includes('ThisIsAnExtremelyLong'), null, {timeout: 15000});
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent?.includes('译文：'), null, {timeout: 15000});
    await page.keyboard.press('Escape');

    const capture = async (name, checks = () => {}) => {
      const snapshot = await geometrySnapshot(page, name);
      if (snapshot.menuButton) {
        assert.equal(snapshot.menuButton.role, 'button'); assert.equal(snapshot.menuButton.hasPopup, 'menu');
        assert.equal(snapshot.menuButton.controls, 'fluent-read-video-subtitle-menu'); assert.equal(snapshot.menuButton.pressed, null);
        assert.equal(typeof snapshot.menuButton.menuHidden, 'boolean');
        assert.equal(snapshot.menuButton.expanded, String(!snapshot.menuButton.menuHidden));
      }
      await checks(snapshot);
      report.cases.push(snapshot);
      await page.screenshot({path:path.join(artifacts, `${name}.png`)});
      return snapshot;
    };
    await capture('bilingual-contain', snapshot => {
      assert.ok(snapshot.menuButton); assert.equal(snapshot.button, 'true');
      assert.equal(snapshot.player.width, 720);
      assert.equal(snapshot.player.height, 640);
      assert.equal(snapshot.video.width, 360);
      assert.equal(snapshot.video.height, 640);
      assert.equal(Math.round(snapshot.video.left - snapshot.player.left), 180);
      assert.ok(snapshot.panel && snapshot.panel.width <= 362 && snapshot.panel.left >= snapshot.video.left - 2 && snapshot.panel.right <= snapshot.video.right + 2, JSON.stringify(snapshot));
      assert.match(snapshot.originalText, /ThisIsAnExtremelyLong/);
      assert.match(snapshot.translationText, /[\u4e00-\u9fff]/u);
      assert.notEqual(snapshot.layerClipPath, 'none');
      assert.equal(snapshot.originalFits, true);
      assert.equal(snapshot.translationFits, true);
    });

    const modes = ['original-only', 'translation-only', 'bilingual'];
    for (const mode of modes) {
      await control.evaluate(async nextMode => {
        const read = await chrome.runtime.sendMessage({type:'configStorageRead', key:'local:config'});
        const current = typeof read?.value === 'string' ? JSON.parse(read.value) : (read?.value || {});
        return chrome.runtime.sendMessage({type:'persistConfig', clientId:'x-portrait-geometry', sequence:Date.now(), config:{...current, videoSubtitleDisplayMode:nextMode}, ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision:current.__fluentConfigRevision} : {})});
      }, mode);
      await page.waitForTimeout(350);
      const snapshot = await capture(`mode-${mode}`);
      if (mode === 'original-only') assert.equal(snapshot.translationVisible, false);
      if (mode === 'translation-only') assert.equal(snapshot.originalVisible, false);
      if (mode === 'bilingual') { assert.equal(snapshot.originalVisible, true); assert.equal(snapshot.translationVisible, true); }
    }

    await page.evaluate(() => document.querySelector('#player')?.classList.add('fixture-hidden'));
    await page.waitForTimeout(300);
    await capture('controls-hidden', snapshot => assert.equal(snapshot.controlsVisible, false));
    await page.evaluate(() => document.querySelector('#player')?.classList.remove('fixture-hidden'));
    await page.waitForTimeout(300);
    await capture('controls-visible', snapshot => assert.equal(snapshot.controlsVisible, true));

    await page.evaluate(() => document.querySelector('#fullscreen')?.click());
    await page.waitForTimeout(500);
    await capture('fullscreen', snapshot => assert.equal(snapshot.fullscreen, true));
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await page.waitForTimeout(500);
    await capture('exit-fullscreen', snapshot => assert.equal(snapshot.fullscreen, false));

    await page.evaluate(() => {
      const old = document.querySelector('video');
      const replacement = old.cloneNode(false);
      replacement.id = 'video'; replacement.controls = true; replacement.playsInline = true;
      replacement.src = old.src; old.replaceWith(replacement); replacement.load();
      const track = replacement.addTextTrack('captions', 'English', 'en');
      track.addCue(new VTTCue(0, 3, 'ThisIsAnExtremelyLongUnbrokenEnglishSubtitleThatMustWrapInsideThePortraitVideoContentRectWithoutEscapingTheLayerBounds'));
      track.mode = 'showing';
    });
    await page.waitForTimeout(1000);
    await page.locator('video').hover();
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent?.includes('ThisIsAnExtremelyLong'), null, {timeout: 15000});
    await capture('video-remount', snapshot => { assert.match(snapshot.originalText, /ThisIsAnExtremelyLong/); assert.match(snapshot.translationText, /译文：/); });

    await page.evaluate(() => {
      const player = document.querySelector('#player');
      const video = document.querySelector('video');
      player.style.width = '720px'; player.style.height = '640px';
      video.style.left = '0'; video.style.top = '0'; video.style.width = '720px'; video.style.height = '640px'; video.style.objectFit = 'contain';
    });
    await page.waitForTimeout(500);
    await capture('contain-video-element-full-width', snapshot => {
      const contentLeft = snapshot.player.left + 180;
      const contentRight = snapshot.player.left + 540;
      assert.ok(snapshot.panel.left >= contentLeft - 2 && snapshot.panel.right <= contentRight + 2, JSON.stringify({snapshot, contentLeft, contentRight}));
    });

    await page.evaluate(() => {
      const player = document.querySelector('#player');
      const video = document.querySelector('video');
      player.style.width = '640px'; player.style.height = '480px';
      video.style.left = '0'; video.style.top = '0'; video.style.width = '640px'; video.style.height = '480px'; video.style.objectFit = 'contain';
    });
    await page.waitForTimeout(600);
    await capture('contain-video-resize-640x480', snapshot => {
      const contentWidth = 270;
      const contentLeft = snapshot.player.left + (640 - contentWidth) / 2;
      const contentRight = contentLeft + contentWidth;
      assert.ok(snapshot.panel.left >= contentLeft - 2 && snapshot.panel.right <= contentRight + 2, JSON.stringify({snapshot, contentLeft, contentRight}));
    });

    await page.route(youtubeUrl, route => route.fulfill({status:200, contentType:'text/html', body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube portrait compatibility fixture</title><style>html,body{margin:0;background:#eef1f5}body{padding:24px}#movie_player{position:relative;width:960px;height:540px;background:#111;overflow:hidden}.html5-main-video{position:absolute;inset:0;width:960px;height:540px}.ytp-right-controls{position:absolute;right:18px;bottom:14px;z-index:10}.ytp-right-controls button{height:36px;background:#27384a;color:#fff;border:0}.ytp-caption-window-container{position:absolute;left:0;right:0;top:65%;height:20%;z-index:4;text-align:center;color:#fff;font:600 28px/1.3 Arial}.ytp-caption-segment{display:inline-block;background:rgba(0,0,0,.6);padding:4px 8px}</style></head><body><div id="movie_player" class="html5-video-player"><video class="html5-main-video" controls playsinline></video><div id="ytp-caption-window-container" class="ytp-caption-window-container"><span class="ytp-caption-segment">YouTube native caption remains visible.</span></div><div class="ytp-right-controls"><button aria-label="Settings">Settings</button></div></div></body></html>`}), {times:1});
    await page.goto(youtubeUrl, {waitUntil:'domcontentloaded'});
    await activate(page);
    await page.evaluate((base64) => {
      const video = document.querySelector('video');
      video.src = `data:video/mp4;base64,${base64}`;
      video.load();
      video.currentTime = 0.4;
    }, videoBytes);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, {timeout: 15000});
    await page.locator('video').hover();
    await page.waitForSelector('#fluent-read-video-subtitle-button', {timeout: 15000});
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent?.includes('译文：'), null, {timeout: 15000});
    const youtubeGeometry = await page.evaluate(() => {
      const rect = element => { const value = element?.getBoundingClientRect(); return value ? {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height} : null; };
      const player = document.querySelector('#movie_player');
      const native = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      const panel = document.querySelector('#fluent-read-video-subtitle-panel');
      const original = document.querySelector('#fluent-read-video-subtitle-original');
      const translation = document.querySelector('#fluent-read-video-subtitle');
      const nativeStyle = native ? getComputedStyle(native) : null;
      const nativeVisible = Boolean(nativeStyle && nativeStyle.display !== 'none' && nativeStyle.visibility !== 'hidden' && nativeStyle.opacity !== '0');
      return {phase:'youtube-shared-caption-compat', player:rect(player), native:rect(native), panel:rect(panel), original:rect(original), translation:rect(translation), nativeVisible, nativeText:native?.textContent?.trim() || '', originalText:original?.textContent?.trim() || '', translationText:translation?.textContent?.trim() || ''};
    });
    assert.ok(youtubeGeometry.panel && youtubeGeometry.native, JSON.stringify(youtubeGeometry));
    if (youtubeGeometry.nativeVisible) {
      assert.ok(youtubeGeometry.panel.bottom <= youtubeGeometry.native.top + 2, JSON.stringify(youtubeGeometry));
    } else {
      assert.equal(youtubeGeometry.originalText, youtubeGeometry.nativeText);
    }
    assert.ok(youtubeGeometry.panel.left >= youtubeGeometry.player.left && youtubeGeometry.panel.right <= youtubeGeometry.player.right, JSON.stringify(youtubeGeometry));
    assert.equal(youtubeGeometry.nativeText, 'YouTube native caption remains visible.');
    assert.match(youtubeGeometry.translationText, /译文：/);
    report.cases.push(youtubeGeometry);
    await page.screenshot({path:path.join(artifacts, 'youtube-shared-caption-compat.png')});

    await control.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type:'configStorageRead', key:'local:config'});
      const current = typeof read?.value === 'string' ? JSON.parse(read.value) : (read?.value || {});
      return chrome.runtime.sendMessage({type:'persistConfig', clientId:'x-portrait-geometry', sequence:Date.now(), config:{...current, on:false, videoTranslationEnabled:false, videoSubtitleVisible:false}, ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision:current.__fluentConfigRevision} : {})});
    });
    await page.waitForTimeout(500);
    const cleanup = await page.evaluate(() => ({
      button: Boolean(document.querySelector('#fluent-read-video-subtitle-button')),
      menu: Boolean(document.querySelector('#fluent-read-video-subtitle-menu')),
      layer: Boolean(document.querySelector('#fluent-read-video-subtitle-layer')),
      aiCaption: Boolean(document.querySelector('#fluent-read-video-ai-caption-container')),
    }));
    report.cleanup = cleanup;
    assert.deepEqual(cleanup, {button:false, menu:false, layer:false, aiCaption:false});
    report.requests = await worker.evaluate(() => globalThis.xPortraitTranslationRequests || []);
    assert.ok(report.requests.length > 0 && report.requests.every(text => text.includes('ThisIsAnExtremelyLong') || text.includes('YouTube native caption')));
    await page.screenshot({path:path.join(artifacts, 'cleanup.png')});
  } catch (error) {
    report.errors.push(error.stack || String(error));
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    await page?.close().catch(() => {});
    await control?.close().catch(() => {});
    let sessionClosed = !launchAttempted;
    try { if (browserSession) { await browserSession.close(); sessionClosed = true; } }
    catch (error) { report.cleanupError = error.stack || String(error); process.exitCode = 1; }
    if (profileDir && sessionClosed) {
      try { fs.rmSync(profileDir, {recursive:true, force:true, maxRetries:5, retryDelay:200}); }
      catch (error) { report.profileCleanupError = error.stack || String(error); process.exitCode = 1; }
    } else if (profileDir) report.retainedProfile = profileDir;
    try { if (mediaDir) fs.rmSync(mediaDir, {recursive:true, force:true, maxRetries:5, retryDelay:200}); }
    catch (error) { report.mediaCleanupError = error.stack || String(error); process.exitCode = 1; }
    fs.writeFileSync(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ok:!process.exitCode, artifacts, cases:report.cases.length, translationRequests:report.requests.length}, null, 2));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
