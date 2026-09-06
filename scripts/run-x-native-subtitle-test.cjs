#!/usr/bin/env node
// Production X native TextTrack fixture. No Whisper/model preparation is used.
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
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-x-native-subtitle-proof'));
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
  asrCalls: 0,
  prepareCalls: 0,
  translationCalls: 0,
};
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-x-native-profile-'));
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
    body: `<!doctype html><html><body style="margin:24px;background:#f3f5f9"><h1>X native subtitle fixture</h1><article><a href="/cerebras/status/2089870131291943228/video/1">View media</a><div data-testid="videoPlayer" style="position:relative;width:960px;height:540px;background:#10283f"><video controls style="width:100%;height:100%"></video></div></article></body></html>`,
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
  report.baseFontSize = await page.locator('#fluent-read-video-subtitle').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  assert.equal((await persistConfig(control, 130)).success, true);
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-panel')?.style.getPropertyValue('--fluent-read-video-subtitle-font-scale') === '130%');
  report.appearance = await page.evaluate(() => {
    const player = document.querySelector('[data-testid="videoPlayer"]');
    const panel = document.querySelector('#fluent-read-video-subtitle-panel');
    const translated = document.querySelector('#fluent-read-video-subtitle');
    const original = document.querySelector('#fluent-read-video-subtitle-original');
    if (!player || !panel || !translated || !original) throw new Error('subtitle appearance nodes are missing');
    const panelStyle = getComputedStyle(panel);
    const translatedStyle = getComputedStyle(translated);
    const originalStyle = getComputedStyle(original);
    const panelRect = panel.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    return {
      skin: panel.dataset.fluentReadSubtitleSkin,
      top: panelStyle.top,
      bottom: panelStyle.bottom,
      inlineTop: panel.style.top,
      inlineBottom: panel.style.bottom,
      relativeTop: panelRect.top - playerRect.top,
      maxWidth: panelStyle.maxWidth,
      maxWidthVariable: panelStyle.getPropertyValue('--fluent-read-video-subtitle-max-width').trim(),
      fontSize: translatedStyle.fontSize,
      fontScaleVariable: panelStyle.getPropertyValue('--fluent-read-video-subtitle-font-scale').trim(),
      background: panelStyle.backgroundColor,
      textColor: originalStyle.color,
      translationColor: translatedStyle.color,
      translatedStroke: translatedStyle.webkitTextStrokeWidth,
      originalStroke: originalStyle.webkitTextStrokeWidth,
      translatedShadow: translatedStyle.textShadow,
      originalShadow: originalStyle.textShadow,
    };
  });
  assert.equal(report.appearance.skin, 'clean');
  assert.equal(report.appearance.maxWidthVariable, '78%');
  assert.equal(report.appearance.fontScaleVariable, '130%');
  assert.match(report.appearance.top, /px$/);
  assert.match(report.appearance.inlineTop, /px$/);
  assert.equal(report.appearance.inlineBottom, 'auto');
  assert.ok(report.appearance.relativeTop > 0 && report.appearance.relativeTop <= 100);
  assert.ok(Number.parseFloat(report.appearance.maxWidth) <= 1000);
  assert.ok(Math.abs(Number.parseFloat(report.appearance.fontSize) / report.baseFontSize - 1.3) < .01, '130% must scale the actual player subtitle relative to its 100% baseline');
  assert.match(report.appearance.background, /rgba?\(255, 255, 255/i);
  assert.match(report.appearance.textColor, /rgb\(31, 41, 55\)/i);
  assert.match(report.appearance.translationColor, /rgb\(15, 118, 110\)/i);
  assert.ok(report.appearance.translatedStroke === '0px' && report.appearance.originalStroke === '0px');
  assert.equal(report.appearance.translatedShadow, 'none');
  assert.equal(report.appearance.originalShadow, 'none');
  await screenshot(page, 'native-clean-top');
  await screenshot(page, 'native-bilingual');

  await page.locator('[data-mode="original-only"]').click();
  await waitForNativeText(page, '오늘은 좋은 날입니다.');
  assert.equal(await page.locator('#fluent-read-video-subtitle').textContent(), '');
  await screenshot(page, 'native-original-only');
  await page.locator('[data-mode="bilingual"]').click();
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent?.includes('译文：'));
  await seek(3.3);
  await page.waitForFunction(time => Math.abs(document.querySelector('video').currentTime - time) < 0.1, 3.3);
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('timeupdate')));
  await waitForNativeText(page, '커피를 마시고 친구를 만났습니다.');
  assert.match(await page.locator('#fluent-read-video-subtitle-original').textContent(), /[가-힣]/u);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="download-subtitles"]').click();
  const download = await downloadPromise;
  const srtPath = path.join(artifacts, 'native-original.srt');
  await download.saveAs(srtPath);
  report.srtPath = srtPath;
  report.srt = fs.readFileSync(srtPath, 'utf8');
  assert.doesNotMatch(report.srt, /X-word-ms|character_ranges|&lt;|<v /i);
  report.translationSources = await worker.evaluate(() => globalThis.proofTranslationSources);
  assert.ok(report.translationSources.length > 0);
  for (const source of report.translationSources) assert.doesNotMatch(source, /X-word-ms|character_ranges|&lt;|<v /i);
  assert.match(report.srt, /오늘은 좋은 날입니다\./u);
  assert.match(report.srt, /커피를 마시고 친구를 만났습니다\./u);
  assert.match(report.srt, /내일은 함께 공원에 가려고 합니다\./u);

  await persistConfig(control, 100, {position: 'bottom', autoBottom: true, bottomOffset: 10});
  await page.locator('h1').click();
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.controls = false;
    const bar = document.createElement('div');
    bar.id = 'fixture-x-controls';
    bar.style.cssText = 'position:absolute;bottom:0;left:0;width:100%;height:48px;opacity:0;pointer-events:none;background:#202020';
    bar.innerHTML = '<button aria-label="Play">Play</button><button aria-label="Settings">Settings</button>';
    video.parentElement.appendChild(bar);
  });
  const readPlacement = () => page.evaluate(() => {
    const player = document.querySelector('[data-testid="videoPlayer"]');
    const panel = document.querySelector('#fluent-read-video-subtitle-panel');
    const a = player.getBoundingClientRect();
    const b = panel.getBoundingClientRect();
    return {gap: a.bottom - b.bottom, top: b.top - a.top, height: b.height, playerHeight: a.height};
  });
  const waitBottom = expected => page.waitForFunction(value => {
    const panel = document.querySelector('#fluent-read-video-subtitle-panel');
    const player = document.querySelector('[data-testid="videoPlayer"]');
    return panel && Math.abs(player.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom - value) < 2;
  }, expected, {timeout: 10000});
  await waitBottom(12);
  report.autoBottomHidden = await readPlacement();
  await screenshot(page, 'native-bottom-hidden-controls');
  await page.evaluate(() => { const bar = document.querySelector('#fixture-x-controls'); bar.style.opacity = '1'; bar.style.pointerEvents = 'auto'; });
  await waitBottom(56);
  report.autoBottomVisible = await readPlacement();
  await screenshot(page, 'native-bottom-visible-controls');
  await page.evaluate(() => {
    document.querySelector('#fixture-x-controls').style.opacity = '0';
    const player = document.querySelector('[data-testid="videoPlayer"]');
    player.style.width = '480px'; player.style.height = '270px';
  });
  await waitBottom(12);
  report.autoBottomResized = await readPlacement();
  assert.ok(report.autoBottomResized.top >= 0);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'fixture-fullscreen';
    button.textContent = 'Fullscreen';
    button.onclick = () => document.querySelector('[data-testid="videoPlayer"]').requestFullscreen();
    document.body.prepend(button);
  });
  await helper.activateExtensionTabWithoutForeground({serviceWorkers: () => [worker]}, page);
  await page.locator('#fixture-fullscreen').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await waitBottom(12);
  report.autoBottomFullscreen = await readPlacement();
  await screenshot(page, 'native-bottom-fullscreen');
  await page.evaluate(() => document.exitFullscreen());
  await persistConfig(control, 100, {position: 'bottom', autoBottom: false, bottomOffset: 16});
  await waitBottom(270 * .16);
  report.manualBottomOffset = await readPlacement();
  await page.locator('video').hover();
  await page.evaluate(() => { const bar = document.querySelector('#fixture-x-controls'); bar.style.opacity = '1'; bar.style.pointerEvents = 'auto'; });
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.locator('[data-action="toggle-translation"]').click();
  await page.waitForFunction(() => document.querySelector('video').textTracks[0].mode === 'showing');
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[1].mode), 'disabled');
  report.nativeRestored = await page.evaluate(() => document.querySelector('video').textTracks[0].mode);
  report.asrCalls = await worker.evaluate(() => globalThis.proofAsrCalls);
  report.prepareCalls = await worker.evaluate(() => globalThis.proofPrepareCalls);
  report.translationCalls = await worker.evaluate(() => globalThis.proofTranslationCalls);
  assert.equal(report.asrCalls, 0, 'native subtitle path must not request local ASR');
  assert.equal(report.prepareCalls, 0, 'native subtitle path must not prepare local model');
  assert.ok(report.translationCalls > 0, 'native subtitle path should translate the selected source cue');
  report.optionsPages = context.pages().filter(candidate => candidate.url().includes('/options.html')).length;
  assert.equal(report.optionsPages, 0);
  report.launchMode = browser.launchMode;
  report.focusPolicy = browser.focusPolicy;
  report.windowPlacement = browser.windowPlacement;
  assert.equal(report.windowPlacement.browserFrontmost, false);
  report.success = true;
}

main().catch(async error => {
  report.failure = error.stack;
  process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(artifacts, 'failure.png')}).catch(() => {});
}).finally(async () => {
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({success: report.success, failure: report.failure, artifacts}, null, 2));
  if (browser) await browser.close();
  fs.rmSync(profileDir, {recursive: true, force: true});
});
