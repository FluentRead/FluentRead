#!/usr/bin/env node
// Production-extension regression with controlled YouTube DOM/time and a mocked
// translation service. Fullscreen and clicks use the real browser; no live media claim.
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-youtube-sync'));
const helperPath = arg('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'));
const playwrightRoot = arg('playwright-root');
if (!helperPath || !playwrightRoot) throw new Error('Explicit focus-safe helper and Playwright runtime are required');
const helper = require(path.resolve(helperPath));
const {createRuntimeDiagnostics} = require(path.resolve(arg('runtime-diagnostics-helper',
  path.join(os.homedir(), '.codex/skills/fluentread-browser-translation-test/scripts/runtime-diagnostics.cjs'))));
const diagnostics = createRuntimeDiagnostics();
const {chromium} = createRequire(path.join(playwrightRoot, 'youtube-sync-proof.cjs'))('playwright');
fs.mkdirSync(artifacts, {recursive: true});
const mediaFile = path.join(artifacts, 'fixture.mp4');
const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'color=c=0x123044:s=960x540:r=10',
  '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], {encoding: 'utf8'});
assert.equal(media.status, 0, media.stderr);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-edge-profile-youtube-sync-'));
const report = {success: false, evidence: 'Production extension; controlled YouTube DOM and video clock; mocked translations; real fullscreen/clicks', checks: [], errors: []};
let session, page;
let primaryError;
const translations = {
  'Sea otters have strong teeth.': '海獭有强有力的牙齿。',
  'They open the shell.': '它们打开贝壳。',
  'The same beginning belongs to a future sentence.': '这是一条未来的字幕。',
  'Slow translation belongs here.': '这是一条延迟的译文。',
  'The next caption is ready.': '下一句字幕已就绪。',
  'A native sentence without a timed track.': '这句原文没有时间轨道。',
  'Another native sentence.': '另一句原文。',
};
const cues = [
  {tStartMs: 0, dDurationMs: 1000, segs: [{utf8: 'Sea otters have strong teeth.'}]},
  {tStartMs: 1000, dDurationMs: 1000, segs: [{utf8: 'They open the shell.'}]},
  {tStartMs: 2000, dDurationMs: 1000, segs: [{utf8: 'Sea otters have strong teeth.'}]},
  {tStartMs: 8000, dDurationMs: 1000, segs: [{utf8: 'The same beginning belongs to a future sentence.'}]},
  {tStartMs: 10000, dDurationMs: 1000, segs: [{utf8: 'Slow translation belongs here.'}]},
  {tStartMs: 11000, dDurationMs: 1000, segs: [{utf8: 'The next caption is ready.'}]},
  {tStartMs: 14000, dDurationMs: 4000, segs: [{utf8: 'They serve drinks.'}]},
  {tStartMs: 16000, dDurationMs: 3000, segs: [{utf8: "I thought I'd try out this beer."}]},
];
const check = (name, pass, details) => report.checks.push({name, pass: Boolean(pass), details});
let launchAttempted = false;
(async () => {
  launchAttempted = true;
  session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
    browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    headless: false, background: true, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
  });
  guardBrowserClose(session, profileDir);
  const {context} = session;
  await diagnostics.start(context);
  Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
  const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith('/background.js'))
    || await context.waitForEvent('serviceworker', {predicate: candidate => candidate.url().endsWith('/background.js')});
  diagnostics.setExtensionId(new URL(worker.url()).host);
  await worker.evaluate(mapping => {
    const originalFetch = globalThis.fetch;
    globalThis.fixturePending = [];
    globalThis.fixtureRequests = [];
    globalThis.fetch = async (input, init) => {
      if (!String(input?.url || input).startsWith('https://edge.microsoft.com/translate/translatetext')) return originalFetch(input, init);
      const body = JSON.parse(init?.body || '[]');
      const source = String(body[0]?.Text ?? body[0] ?? '');
      globalThis.fixtureRequests.push(source);
      globalThis.fixtureRequestTimes ??= [];
      globalThis.fixtureRequestTimes.push({source, at: Date.now()});
      if (source === 'Slow translation belongs here.') await new Promise(resolve => globalThis.fixturePending.push(resolve));
      return new Response(JSON.stringify([{translations: [{text: mapping[source] || `译文：${source}`}]}]), {status: 200, headers: {'content-type': 'application/json'}});
    };
  }, translations);
  const control = await helper.newPageWithoutForeground(context);
  await diagnostics.attachPage(control, 'config-popup');
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  let sequence = 0;
  const patchConfig = async patch => {
    const result = await control.evaluate(async ({patch, sequence}) => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value || {};
      return chrome.runtime.sendMessage({type: 'persistConfig', clientId: 'youtube-sync-proof', sequence,
        config: {...current, ...patch}, ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision: current.__fluentConfigRevision} : {})});
    }, {patch, sequence: ++sequence});
    assert.equal(result.success, true);
  };
  await patchConfig({on: true, uiLanguage: 'zh-CN', from: 'en', to: 'zh-Hans', videoTranslationEnabled: true,
    videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', videoService: 'microsoft', videoServiceDefaultMigrated: true});
  const url = 'https://www.youtube.com/watch?v=fluentread-sync-fixture';
  await context.route(url, route => route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>YouTube fullscreen and subtitle synchronization fixture</title><style>
    html{height:0}body{margin:0;background:#eef2f8;font:18px Arial}#movie_player{position:fixed;left:40px;top:80px;width:960px;height:540px;overflow:hidden;background:#123044;color:white}
    video{position:absolute;width:100%;height:100%;inset:0}.ytp-right-controls{position:absolute;right:16px;bottom:8px;display:flex;gap:8px;height:40px;z-index:30}.ytp-right-controls button{min-width:36px;height:36px}
    #ytp-caption-window-container{position:absolute;left:0;right:0;bottom:64px;text-align:center}.ytp-caption-segment{font-size:28px;background:#111}
    html:fullscreen #movie_player{inset:0;width:100vw;height:100vh}html:fullscreen{height:0!important}
    </style></head><body><h1>字幕全屏与时间同步回归</h1><div id="movie_player" class="html5-video-player"><video class="html5-main-video" muted src="data:video/mp4;base64,${fs.readFileSync(mediaFile).toString('base64')}"></video><div id="ytp-caption-window-container"><span class="ytp-caption-segment"></span></div><div class="ytp-right-controls"><button id="fullscreen">全屏</button><button aria-label="Settings">设置</button></div></div>
    <script>document.getElementById('fullscreen').onclick=()=>document.documentElement.requestFullscreen();</script></body></html>`}));
  page = await helper.newPageWithoutForeground(context);
  await diagnostics.attachPage(page, 'youtube-caption-page');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url);
  await helper.activateExtensionTabWithoutForeground({serviceWorkers: () => [worker]}, page);
  await page.locator('#fluent-read-video-subtitle-button').waitFor();
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const setCaption = async (time, text) => {
    diagnostics.setPhase(`caption-${time}`);
    await page.evaluate(({time, text}) => {
      document.querySelector('.ytp-caption-segment').textContent = text;
      document.querySelector('video').currentTime = time;
    }, {time, text});
    await page.waitForFunction(() => !document.querySelector('video').seeking);
  };
  const sample = () => page.evaluate(() => {
    const original = document.querySelector('#fluent-read-video-subtitle-original');
    const translation = document.querySelector('#fluent-read-video-subtitle');
    const panel = document.querySelector('#fluent-read-video-subtitle-panel');
    const layer = document.querySelector('#fluent-read-video-subtitle-layer');
    const native = document.querySelector('.ytp-caption-segment');
    return {time: document.querySelector('video').currentTime, original: original?.textContent || '', translation: translation?.textContent || '', native: native.textContent,
      nativeVisibility: getComputedStyle(native).visibility, panel: panel?.getBoundingClientRect().toJSON(), layerParent: layer?.parentElement?.id,
      panelDisplay: panel && getComputedStyle(panel).display};
  });
  const waitTranslation = text => page.waitForFunction(text => document.querySelector('#fluent-read-video-subtitle')?.textContent === text, text, {timeout: 10000});
  await page.evaluate(events => window.postMessage({source: 'fluent-read', type: 'fluent-read-youtube-timedtext',
    url: 'https://www.youtube.com/api/timedtext?v=fluentread-sync-fixture&lang=en', responseText: JSON.stringify({events})}, location.origin), cues);
  await setCaption(.5, 'Sea otters have strong teeth.');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  const first = await sample();
  check('Whole native cue uses one bilingual panel', first.original === first.native && first.nativeVisibility === 'hidden', first);
  await page.evaluate(() => {
    window.fixtureNativeFrames = {samples: 0, visibleFrames: 0, failures: [], running: true};
    const sample = () => {
      const result = window.fixtureNativeFrames;
      if (!result.running) return;
      const native = document.querySelector('#movie_player #ytp-caption-window-container .ytp-caption-segment');
      if (native?.textContent) {
        result.samples++;
        if (getComputedStyle(native).visibility !== 'hidden') {
          result.visibleFrames++;
          if (result.failures.length < 60) result.failures.push({time: document.querySelector('video').currentTime, text: native.textContent});
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.evaluate(() => window.fixtureMenu = document.querySelector('#fluent-read-video-subtitle-menu'));
  // Enter fullscreen without an outside click, as with YouTube's F shortcut.
  const cdp = await context.newCDPSession(page);
  let cdpError;
  try {await cdp.send('Runtime.evaluate', {expression: 'document.documentElement.requestFullscreen()', userGesture: true, awaitPromise: true});}
  catch (error) {cdpError = error; throw error;}
  finally {
    try {await cdp.detach();} catch (error) {
      if (!cdpError) throw error;
      process.stderr.write(`CDP detach failed: ${error.stack || error}\n`);
    }
  }
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.waitForTimeout(250);
  const fullscreen = await page.evaluate(() => {
    const menu = document.querySelector('#fluent-read-video-subtitle-menu');
    const layer = document.querySelector('#fluent-read-video-subtitle-layer');
    const r = menu.getBoundingClientRect();
    return {root: document.fullscreenElement.tagName, menuParent: menu.parentElement.id, layerParent: layer?.parentElement.id,
      sameMenu: menu === window.fixtureMenu, hidden: menu.hidden, menuRect: r.toJSON(), layerHeight: layer?.getBoundingClientRect().height,
      hit: Boolean(menu.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)))};
  });
  check('Document fullscreen preserves an open, visible, clickable menu and full-height subtitle layer', fullscreen.menuParent === 'movie_player'
    && fullscreen.layerParent === 'movie_player' && fullscreen.sameMenu && !fullscreen.hidden && fullscreen.hit && fullscreen.layerHeight > 300, fullscreen);
  await page.screenshot({path: path.join(artifacts, 'fullscreen.png')});
  if (fullscreen.hit) {
    await page.locator('[data-mode="translation-only"]').click();
    check('Fullscreen menu switches display mode', await page.locator('[data-mode="translation-only"]').getAttribute('aria-checked') === 'true');
    await page.locator('[data-mode="bilingual"]').click();
  }
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForTimeout(150);
  await page.locator('#movie_player').click({position: {x: 20, y: 20}});
  await setCaption(.5, 'Sea otters');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  const partial = await sample();
  check('Partial and whole captions share stable geometry', partial.original === first.native && Math.abs(partial.panel.bottom - first.panel.bottom) < 1.5, partial);
  await setCaption(1.2, 'Sea otters have strong teeth.');
  await page.waitForTimeout(80);
  const stale = await sample();
  check('A late native DOM update never reveals the next unrelated cue or retains its previous translation', stale.translation === '' && stale.original === '', stale);
  check('An expired native cue stays hidden while the next DOM update is pending', stale.nativeVisibility === 'hidden', stale);
  await setCaption(1.2, 'They open the shell.');
  await waitTranslation(translations['They open the shell.']);
  await setCaption(2.2, 'Sea otters have strong teeth.');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  check('A repeated sentence is allowed in its own later interval', (await sample()).original === 'Sea otters have strong teeth.');
  await setCaption(3.2, 'Sea otters have strong teeth.');
  await page.waitForTimeout(80);
  check('Expired cues disappear at their end, including a repeated sentence', (await sample()).translation === '', await sample());
  await setCaption(4, 'The same beginning');
  await page.waitForTimeout(550);
  check('A matching prefix does not borrow a future full sentence', !(await sample()).original.includes('future') && (await sample()).translation === '', await sample());
  // Issue #1341：视频连续重复同一句时，滚动窗口会同时保留上一行与当前行；
  // 面板必须只读取并翻译当前句一次，而不是把两句相同文本拼成一份双语字幕。
  await page.evaluate(lines => {
    document.querySelector('#ytp-caption-window-container').innerHTML = lines.map(line => `<span class="ytp-caption-segment">${line}</span>`).join('');
    document.querySelector('video').currentTime = 5.2;
  }, ['A native sentence without a timed track.', 'A native sentence without a timed track.']);
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  diagnostics.setPhase('caption-5.2-rolling-duplicate');
  await waitTranslation(translations['A native sentence without a timed track.']);
  const rollingDuplicate = await sample();
  check('A rolling window repeating the same sentence shows and translates it once', rollingDuplicate.original === 'A native sentence without a timed track.'
    && rollingDuplicate.translation === translations['A native sentence without a timed track.'], rollingDuplicate);
  const rollingRequest = await worker.evaluate(() => globalThis.fixtureRequests.filter(source => source.includes('A native sentence')).slice(-1)[0]);
  check('The duplicated rolling line is never sent to the translation service', rollingRequest === 'A native sentence without a timed track.', {rollingRequest});
  await page.evaluate(() => {document.querySelector('#ytp-caption-window-container').innerHTML = '<span class="ytp-caption-segment"></span>';});
  await setCaption(10.2, 'Slow translation belongs here.');
  await page.waitForTimeout(150);
  await setCaption(11.2, 'The next caption is ready.');
  await waitTranslation(translations['The next caption is ready.']);
  await worker.evaluate(() => globalThis.fixturePending.splice(0).forEach(resolve => resolve()));
  await page.waitForTimeout(250);
  check('A delayed translation cannot overwrite a newer caption', (await sample()).translation === translations['The next caption is ready.'], await sample());
  const seeking = await page.evaluate(() => new Promise(resolve => {
    const video = document.querySelector('video');
    video.addEventListener('seeking', () => resolve({original: document.querySelector('#fluent-read-video-subtitle-original')?.textContent || '',
      translation: document.querySelector('#fluent-read-video-subtitle')?.textContent || ''}), {once: true});
    video.currentTime = .5;
  }));
  check('Seeking immediately clears both extension lines', !seeking.original && !seeking.translation, seeking);
  await setCaption(.5, 'Sea otters have strong teeth.', 'seeked');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  check('Seeking back restores the current cached cue', (await sample()).original === 'Sea otters have strong teeth.');
  await setCaption(.6, '');
  await page.waitForTimeout(80);
  check('Empty native captions clear the translation without a grace-period tail', !(await sample()).original && !(await sample()).translation, await sample());
  await setCaption(20, 'A native sentence without a timed track.');
  await waitTranslation(translations['A native sentence without a timed track.']);
  // Measure mutation -> outgoing request so provider/network time is excluded.
  const requestStarted = Date.now();
  await setCaption(21, 'Another native sentence.');
  const replacing = await sample();
  check('Untracked native changes invalidate the previous translation before waiting for stability', replacing.original === replacing.native && replacing.translation === '', replacing);
  await waitTranslation(translations['Another native sentence.']);
  const nativeRequest = await worker.evaluate(() => globalThis.fixtureRequestTimes.find(r => r.source === 'Another native sentence.'));
  check('Untracked captions dispatch within 220 ms instead of the former 360 ms stability wait', nativeRequest.at - requestStarted < 220,
    {dispatchMs: nativeRequest.at - requestStarted});
  const replaced = await page.evaluate(() => {
    const previous = document.querySelector('#ytp-caption-window-container');
    const next = document.createElement('div'); next.id = previous.id;
    next.innerHTML = '<div class="captions-text"><span class="ytp-caption-segment">Another native sentence.</span></div>';
    previous.replaceWith(next);
    // Force style resolution before MutationObserver/polling can rebind the new container.
    return {native: next.textContent, visibility: getComputedStyle(next.querySelector('.ytp-caption-segment')).visibility};
  });
  check('A replaced native caption container is hidden immediately, before observer rebinding', replaced.visibility === 'hidden', replaced);
  await page.waitForTimeout(1100);
  await setCaption(16.2, "They serve drinks. I thought");
  await waitTranslation("译文：I thought I'd try out this beer.");
  check('Rolling captions select the current prefix while the previous full cue still overlaps', (await sample()).original === "I thought I'd try out this beer.", await sample());
  // Replay the clipped rolling DOM structure from the supplied page snapshot.
  await page.evaluate(() => {
    document.querySelector('#ytp-caption-window-container').innerHTML = `<div class="ytp-caption-window-rollup" style="height:60px;overflow:hidden"><div style="transform:translateY(-60px)">
      <div style="height:30px"><span class="ytp-caption-segment">Old clipped words.</span></div>
      <div style="height:30px"><span class="ytp-caption-segment">More clipped words.</span></div>
      <div style="height:30px"><span class="ytp-caption-segment">They serve drinks.</span></div>
      <div style="height:30px"><span class="ytp-caption-segment">I thought I'd try</span></div></div></div>`;
  });
  await page.waitForTimeout(80);
  check('Clipped rolling history does not enter the displayed sentence or cause a fallback translation', (await sample()).original === "I thought I'd try out this beer.", await sample());
  await page.screenshot({path: path.join(artifacts, 'rolling.png')});
  await page.evaluate(() => {document.querySelector('#ytp-caption-window-container').innerHTML = '<span class="ytp-caption-segment"></span>';});
  await setCaption(23, '');
  const streamStarted = Date.now();
  await page.evaluate(async () => {
    const segment = document.querySelector('.ytp-caption-segment');
    const words = ['Streaming', 'captions', 'keep', 'adding', 'new', 'words', 'without', 'waiting', 'for', 'a', 'quiet', 'gap.'];
    for (let i = 1; i <= words.length; i++) {
      segment.textContent = words.slice(0, i).join(' ');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  });
  await waitTranslation('译文：Streaming captions keep adding new words without waiting for a quiet gap.');
  const streamRequests = await worker.evaluate(() => globalThis.fixtureRequestTimes.filter(r => r.source.startsWith('Streaming')));
  check('Continuous 40 ms word updates cannot keep postponing the first request', streamRequests[0]?.at - streamStarted < 350,
    {requests: streamRequests.map(r => ({source: r.source, afterMs: r.at - streamStarted}))});
  await setCaption(24, 'Cached native replay.');
  await waitTranslation('译文：Cached native replay.');
  await setCaption(24.2, '');
  const replayStarted = Date.now();
  await setCaption(24.4, 'Cached native replay.');
  await waitTranslation('译文：Cached native replay.');
  check('Cached untracked replay does not repeat a provider request', (await worker.evaluate(() => globalThis.fixtureRequests.filter(s => s === 'Cached native replay.').length)) === 1,
    {renderMs: Date.now() - replayStarted});
  await setCaption(.8, 'Sea otters have strong teeth.');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.locator('[data-action="subtitle-earlier"]').click();
  await waitTranslation(translations['They open the shell.']);
  check('Player menu advances subtitles by 0.5 s without seeking or altering native text', (await sample()).time === .8
    && (await sample()).native === 'Sea otters have strong teeth.' && await page.locator('[data-subtitle-offset]').textContent() === '-0.5 s', await sample());
  await page.locator('[data-action="subtitle-later"]').click();
  await waitTranslation(translations['Sea otters have strong teeth.']);
  await page.locator('[data-action="subtitle-later"]').click();
  await setCaption(1.2, 'They open the shell.');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  check('Positive 0.5 s offset delays the whole bilingual cue', (await sample()).original === 'Sea otters have strong teeth.'
    && await page.locator('[data-subtitle-offset]').textContent() === '+0.5 s', await sample());
  await page.screenshot({path: path.join(artifacts, 'timing-menu.png')});
  await page.locator('[data-mode="original-only"]').click();
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'Sea otters have strong teeth.');
  check('Manual timing also applies in original-only mode', (await sample()).translation === '', await sample());
  await page.locator('[data-mode="bilingual"]').click();
  await waitTranslation(translations['Sea otters have strong teeth.']);
  await setCaption(3.6, 'A native gap.');
  await page.waitForTimeout(80);
  check('Adjusted subtitle clock respects gaps without leaking unadjusted native captions', !(await sample()).original && !(await sample()).translation
    && (await sample()).nativeVisibility === 'hidden', await sample());
  await setCaption(1.2, 'They open the shell.');
  await waitTranslation(translations['Sea otters have strong teeth.']);
  const reopened = await helper.newPageWithoutForeground(context);
  await diagnostics.attachPage(reopened, 'youtube-second-playback-page');
  await reopened.goto(url);
  await reopened.locator('#fluent-read-video-subtitle-button').waitFor();
  await reopened.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await reopened.locator('#fluent-read-video-subtitle-button').click();
  await reopened.waitForFunction(() => document.querySelector('[data-subtitle-offset]')?.textContent === '+0.5 s');
  check('A newly opened playback page restores the saved offset', await reopened.locator('[data-subtitle-offset]').textContent() === '+0.5 s');
  check('Unavailable caption timing disables adjustment while leaving reset usable', await reopened.locator('[data-action="subtitle-earlier"]').isDisabled()
    && await reopened.locator('[data-action="subtitle-later"]').isDisabled() && !await reopened.locator('[data-action="reset-subtitle-timing"]').isDisabled());
  await page.locator('[data-action="subtitle-later"]').click();
  await page.locator('[data-action="subtitle-later"]').click();
  await reopened.waitForFunction(() => document.querySelector('[data-subtitle-offset]')?.textContent === '+1.5 s');
  check('Repeated half-second clicks accumulate and synchronize to another playback page', await page.locator('[data-subtitle-offset]').textContent() === '+1.5 s');
  await page.locator('[data-action="reset-subtitle-timing"]').click();
  await waitTranslation(translations['They open the shell.']);
  await reopened.waitForFunction(() => document.querySelector('[data-subtitle-offset]')?.textContent === '0.0 s');
  check('Reset restores native timing and synchronizes the saved zero offset', await page.locator('[data-subtitle-offset]').textContent() === '0.0 s');
  await reopened.close();
  await setCaption(.3, 'Sea otters have strong teeth.');
  await page.locator('[data-action="subtitle-earlier"]').click();
  await waitTranslation(translations['Sea otters have strong teeth.']);
  await page.evaluate(() => document.querySelector('video').play());
  await waitTranslation(translations['They open the shell.']);
  await page.evaluate(() => document.querySelector('video').pause());
  check('Advancing subtitles follows the playing video clock before the native DOM changes', (await sample()).time >= .5 && (await sample()).time < 1.5
    && (await sample()).native === 'Sea otters have strong teeth.', await sample());
  await page.locator('[data-action="reset-subtitle-timing"]').click();
  await setCaption(24.4, 'Cached native replay.');
  await waitTranslation('译文：Cached native replay.');
  await page.locator('#movie_player').click({position: {x: 20, y: 20}});
  await page.screenshot({path: path.join(artifacts, 'bilingual.png')});
  report.nativeCaptionFrames = await page.evaluate(() => {
    window.fixtureNativeFrames.running = false;
    return window.fixtureNativeFrames;
  });
  check('Animation-frame sampling finds no visible native caption during cue gaps, seeks or container replacement',
    report.nativeCaptionFrames.samples > 0 && report.nativeCaptionFrames.visibleFrames === 0, report.nativeCaptionFrames);
  const unrelated = await page.evaluate(() => {
    const container = document.createElement('div'); container.className = 'ytp-caption-window-container';
    container.innerHTML = '<span class="ytp-caption-segment">Unselected player caption.</span>';
    document.body.appendChild(container);
    const visibility = getComputedStyle(container.firstElementChild).visibility;
    container.remove(); return visibility;
  });
  check('Native captions outside the selected player keep their visibility', unrelated === 'visible', unrelated);
  await patchConfig({videoSubtitleDisplayMode: 'original-only'});
  await page.waitForTimeout(150);
  check('Original-only restores native captions', (await sample()).nativeVisibility === 'visible');
  for (const mode of ['bilingual', 'translation-only']) {
    diagnostics.setPhase(`mode-restoration-${mode}`);
    await patchConfig({videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: mode});
    await waitTranslation('译文：Cached native replay.');
    check(`${mode} suppresses native captions after re-enabling`, (await sample()).nativeVisibility === 'hidden');
    await patchConfig({videoTranslationEnabled: false});
    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-button'));
    check(`Disabling video translation from ${mode} restores native captions`, (await sample()).nativeVisibility === 'visible');
  }
  await patchConfig({videoTranslationEnabled: true, videoSubtitleVisible: false});
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-button'));
  check('Temporarily hidden subtitles also suppress native captions', (await sample()).nativeVisibility === 'hidden');
  await patchConfig({on: false});
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-layer'));
  check('Disabling removes menu, layer and native hiding', !await page.locator('#fluent-read-video-subtitle-menu').count()
    && await page.locator('.ytp-caption-segment').evaluate(e => getComputedStyle(e).visibility === 'visible'));
  report.requests = await worker.evaluate(() => globalThis.fixtureRequests);
  diagnostics.setPhase('disabled-cleanup');
  await diagnostics.flush();
  diagnostics.assertClean();
  report.success = report.checks.every(c => c.pass) && report.errors.length === 0;
  assert.equal(report.success, true, JSON.stringify(report.checks.filter(c => !c.pass)));
})().catch(error => {primaryError = error; report.failure = error.stack; process.exitCode = 1;}).finally(async () => {
  const cleanupErrors = [];
  const cleanup = async action => {
    try {await action();} catch (error) {cleanupErrors.push(error);}
  };
  let browserClosed = false;
  await cleanup(async () => {if (page) fs.writeFileSync(path.join(artifacts, 'last.html'), await page.content().catch(() => ''));});
  await cleanup(async () => {
    await diagnostics.flush();
    report.runtimeDiagnostics = diagnostics.snapshot();
    fs.writeFileSync(path.join(artifacts, 'runtime-diagnostics.json'), JSON.stringify(report.runtimeDiagnostics, null, 2));
  });
  await cleanup(() => diagnostics.stop());
  await cleanup(async () => {
    if (session) {await session.close(); browserClosed = true;}
  });
  await cleanup(() => {
    if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
    else if (!launchAttempted) {
      // No browser launch was attempted; only remove an empty initial profile.
      try {fs.rmdirSync(profileDir);} catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  });
  if (cleanupErrors.length) {
    report.success = false;
    report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
  }
  await cleanup(() => {fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));});
  for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
  if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  console.log(JSON.stringify(report, null, 2));
}).catch(error => {console.error(error.stack || error); process.exitCode = 1;});
