#!/usr/bin/env node
// Reproduce #1341 through the production MAIN-world bridge and content runtime.
// A parser-blocking resource keeps the DOM loading while native timedtext arrives.
// JSON3 and rollup markup follow an observed real YouTube renderer; media, network
// responses and translations are controlled. This is not original-video acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-youtube-handover'));
const playwrightRoot = arg('playwright-root');
if (!playwrightRoot) throw new Error('--playwright-root is required');
const {chromium} = createRequire(path.join(playwrightRoot, 'youtube-handover.cjs'))('playwright');
const helper = require(path.resolve(arg('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'))));
const {createRuntimeDiagnostics} = require(path.resolve(arg('runtime-diagnostics-helper',
  path.join(os.homedir(), '.codex/skills/fluentread-browser-translation-test/scripts/runtime-diagnostics.cjs'))));
const diagnostics = createRuntimeDiagnostics();
const phrase = "Hey, it doesn't matter as long as I get it done!";
const repeatedCue = 'A whole sentence. A whole sentence.';
const events = [
  {tStartMs: 0, dDurationMs: 12000, id: 1, wpWinPosId: 1, wsWinStyleId: 1},
  {tStartMs: 0, dDurationMs: 4500, wWinId: 1, segs: [{utf8: phrase}]},
  {tStartMs: 1990, dDurationMs: 2510, wWinId: 1, aAppend: 1, segs: [{utf8: '\n'}]},
  {tStartMs: 2000, dDurationMs: 4500, wWinId: 1, segs: [{utf8: phrase}]},
  {tStartMs: 3990, dDurationMs: 2510, wWinId: 1, aAppend: 1, segs: [{utf8: '\n'}]},
  {tStartMs: 4000, dDurationMs: 2000, wWinId: 1, segs: [{utf8: 'A different current sentence.'}]},
  {tStartMs: 6000, dDurationMs: 2000, wWinId: 1, segs: [{utf8: 'No no'}]},
  {tStartMs: 8000, dDurationMs: 2000, wWinId: 1, segs: [{utf8: repeatedCue}]},
];
const nativeResponse = JSON.stringify({wireMagic: 'pb3', pens: [{}],
  wsWinStyles: [{}, {mhModeHint: 2, juJustifCode: 0, sdScrollDir: 3}],
  wpWinPositions: [{}, {apPoint: 6, ahHorPos: 20, avVerPos: 100, rcRows: 2, ccCols: 40}], events});
fs.mkdirSync(artifacts, {recursive: true});
const mediaFile = path.join(artifacts, 'clock.mp4');
const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'color=c=0x123044:s=960x540:r=10',
  '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], {encoding: 'utf8'});
assert.equal(media.status, 0, media.stderr);
const mediaData = fs.readFileSync(mediaFile).toString('base64');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-youtube-handover-'));
const report = {success: false, evidence: 'Production extension; controlled response timing, native rollup structure, media clock and translations', cases: [], checks: [], errors: []};
const check = (name, passed, details) => report.checks.push({name, pass: Boolean(passed), details});
let session;

(async () => {
  try {
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
    const extensionId = new URL(worker.url()).host;
    diagnostics.setExtensionId(extensionId);
    await worker.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.handoverRequests = [];
      globalThis.fetch = async (input, init) => {
        if (!String(input?.url || input).startsWith('https://edge.microsoft.com/translate/translatetext')) return originalFetch(input, init);
        const body = JSON.parse(init?.body || '[]'), source = String(body[0]?.Text ?? body[0] ?? '');
        globalThis.handoverRequests.push(source.replace(/&#39;/g, "'"));
        return new Response(JSON.stringify([{translations: [{text: '测试译文：' + source}]}]), {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    // Reuse the helper's initial background target to avoid a second target changing focus.
    const page = context.pages().find(candidate => candidate.url().startsWith('about:blank#fluentread-background-'));
    assert.ok(page, 'Missing focus-safe initial target');
    await diagnostics.attachPage(page, 'youtube-handover-page');
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const configured = await page.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value || {};
      return chrome.runtime.sendMessage({type: 'persistConfig', clientId: 'youtube-handover', sequence: 1,
        config: {...config, on: true, uiLanguage: 'zh-CN', from: 'en', to: 'zh-Hans', videoTranslationEnabled: true,
          videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', videoPreferHumanSubtitles: false,
          videoService: 'microsoft', videoServiceDefaultMigrated: true},
        ...(Number.isSafeInteger(config.__fluentConfigRevision) ? {baseRevision: config.__fluentConfigRevision} : {})});
    });
    assert.equal(configured.success, true);
    let current;
    await context.route('**/api/timedtext?*', route => {
      const native = new URL(route.request().url()).searchParams.has('bootstrap');
      current.requests.push({native, at: Date.now()});
      // Refetch failure is a required part of this regression; no extra native request is necessary after replay.
      return route.fulfill({contentType: 'application/json', body: native ? nativeResponse : ''});
    });
    await context.route('**/1341-parser-gate.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.fulfill({contentType: 'text/javascript', body: 'window.parserGateReleasedAt=performance.now();'});
    });
    for (const mode of ['early', 'late']) {
      diagnostics.setPhase(mode);
      current = {mode, requests: []}; report.cases.push(current);
      await worker.evaluate(() => { globalThis.handoverRequests = []; });
      const videoId = mode === 'early' ? 'fr1341early' : 'fr1341late0';
      const responseUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&bootstrap=1`;
      const metadata = {videoDetails: {videoId}, captions: {playerCaptionsTracklistRenderer: {captionTracks: [
        {baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en'},
      ]}}};
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      await context.route(url, route => route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>YouTube caption handover</title><script>
        window.probeMessages=[];window.addEventListener('message',event=>{if(event.data?.type==='fluent-read-youtube-timedtext')window.probeMessages.push({at:performance.now(),readyState:document.readyState});});
        window.captureNative=()=>fetch(${JSON.stringify(responseUrl)}).then(response=>response.text());
        var ytInitialPlayerResponse=${JSON.stringify(metadata)};
        ${mode === 'early' ? 'window.captureNative();' : ''}
        </script><script src="/1341-parser-gate.js"></script><style>
        body{margin:0;background:#eef2f8}#movie_player{position:relative;margin:80px 40px;width:960px;height:540px;background:#123044}
        video{position:absolute;inset:0;width:100%;height:100%}#ytp-caption-window-container{position:absolute;inset:0}
        .caption-window{position:absolute;left:20%;bottom:2%;overflow:hidden;height:52px;width:574px}
        .caption-visual-line{display:block;height:26px}.ytp-right-controls{position:absolute;bottom:8px;right:16px}
        </style></head><body><div id="movie_player" class="html5-video-player"><video muted src="data:video/mp4;base64,${mediaData}"></video>
        <div id="ytp-caption-window-container"><div id="caption-window-1" class="caption-window ytp-caption-window-bottom ytp-caption-window-rollup">
        <span class="caption-visual-line"><span class="ytp-caption-segment">${phrase}</span></span><span class="caption-visual-line"><span class="ytp-caption-segment">${phrase}</span></span>
        </div></div><div class="ytp-right-controls"><button aria-label="Settings">Settings</button></div></div><script>
        document.querySelector('video').addEventListener('loadedmetadata',()=>{document.querySelector('video').currentTime=2.5;});
        new MutationObserver(()=>{if(document.querySelector('#fluent-read-video-subtitle-button')&&!window.firstUiAt)window.firstUiAt=performance.now();}).observe(document.documentElement,{childList:true,subtree:true});
        </script></body></html>`}));
      await page.goto(url);
      await helper.activateExtensionTabWithoutForeground({serviceWorkers: () => [worker]}, page);
      await page.waitForSelector('#fluent-read-video-subtitle-button');
      await page.waitForFunction(() => document.querySelector('video').currentTime === 2.5 && !document.querySelector('video').seeking);
      if (mode === 'late') await page.evaluate(() => window.captureNative());
      await page.waitForTimeout(900);
      current.initial = await page.evaluate(() => ({
        original: document.querySelector('#fluent-read-video-subtitle-original')?.textContent,
        translation: document.querySelector('#fluent-read-video-subtitle')?.textContent,
        native: Array.from(document.querySelectorAll('.ytp-caption-segment')).map(node => node.textContent),
        messages: window.probeMessages, firstUiAt: window.firstUiAt, parserGateReleasedAt: window.parserGateReleasedAt,
      }));
      current.initialProviderRequests = await worker.evaluate(() => globalThis.handoverRequests);
      const firstMessage = current.initial.messages[0];
      check(`${mode}: response timing is exercised`, firstMessage && (mode === 'early'
        ? firstMessage.readyState === 'loading' && firstMessage.at < current.initial.firstUiAt
        : firstMessage.at > current.initial.firstUiAt), current.initial);
      check(`${mode}: rollup retains two native rows`, current.initial.native.length === 2 && current.initial.native.every(text => text === phrase));
      check(`${mode}: panel displays and translates only the current cue`, current.initial.original === phrase && current.initial.translation === '测试译文：' + phrase, current.initial);
      check(`${mode}: every provider request avoids the rolled duplicate`, !current.initialProviderRequests.includes(`${phrase} ${phrase}`), current.initialProviderRequests);
      check(`${mode}: no replay-driven native refetch`, current.requests.filter(request => request.native).length === 1, current.requests);
      await page.screenshot({path: path.join(artifacts, `${mode}.png`)});
      current.legalRepetition = [];
      for (const [time, parts, expected] of [[.5, [phrase], phrase], [2.5, [phrase, phrase], phrase],
        [6.5, ['No', 'no'], 'No no'], [8.5, ['A whole sentence.', 'A whole sentence.'], repeatedCue]]) {
        await page.evaluate(({time, parts}) => {
          const rollup = document.getElementById('caption-window-1');
          rollup.replaceChildren(...parts.map(text => {
            const row = document.createElement('span'); row.className = 'caption-visual-line';
            const segment = document.createElement('span'); segment.className = 'ytp-caption-segment'; segment.textContent = text;
            row.append(segment); return row;
          }));
          const video = document.querySelector('video'); video.currentTime = time;
        }, {time, parts});
        await page.waitForFunction(() => !document.querySelector('video').seeking);
        await page.waitForTimeout(300);
        const sample = await page.evaluate(() => ({source: document.querySelector('#fluent-read-video-subtitle-original')?.textContent,
          translation: document.querySelector('#fluent-read-video-subtitle')?.textContent}));
        current.legalRepetition.push({time, expected, ...sample});
        check(`${mode}: complete cue at ${time}s`, sample.source === expected && sample.translation === '测试译文：' + expected, sample);
      }
    }
    await diagnostics.flush(); diagnostics.assertClean();
  } catch (error) { report.errors.push({message: error.message, stack: error.stack}); }
  finally {
    await diagnostics.flush(); report.runtimeDiagnostics = diagnostics.snapshot(); await diagnostics.stop();
    if (session) {
      try { await session.close(); report.ownedBrowserClosed = true; }
      catch (error) { report.errors.push({message: error.message, stack: error.stack}); }
    }
    report.success = report.checks.length > 0 && report.checks.every(item => item.pass) && report.errors.length === 0;
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({success: report.success, checks: report.checks.length, failed: report.checks.filter(item => !item.pass),
      errors: report.errors, runtimeCounts: report.runtimeDiagnostics.counts, artifacts}));
    if (!report.success) process.exitCode = 1;
  }
})();
