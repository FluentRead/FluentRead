#!/usr/bin/env node
// Production HTML audio/video regression. Cached transcript UI and optional real Whisper are reported separately.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const arg = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1];};
const extension = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-html-media'));
const packages = arg('playwright-root');
const helperFile = arg('focus-safe-helper');
const diagnosticsFile = arg('runtime-diagnostics-helper');
if (!packages || !helperFile || !diagnosticsFile) throw new Error('Explicit Playwright, focus-safe and runtime diagnostics helpers are required');
const {chromium} = createRequire(path.join(packages, 'html-media-proof.cjs'))('playwright');
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(path.resolve(helperFile));
const {createRuntimeDiagnostics, finalizeRun} = require(path.resolve(diagnosticsFile));
const realAsr = process.argv.includes('--real-asr');
fs.mkdirSync(artifacts, {recursive: true});
function command(bin, args) {const result = spawnSync(bin, args, {encoding: 'utf8'}); assert.equal(result.status, 0, result.stderr);}
const speech = path.join(artifacts, 'speech.aiff'), wav = path.join(artifacts, 'speech.wav'), mp4 = path.join(artifacts, 'speech.mp4');
command('/usr/bin/say', ['-v', 'Samantha', '-o', speech, 'Learning from audio in the browser is useful. This is a local speech recognition test.']);
command('/opt/homebrew/bin/ffmpeg', ['-y', '-i', speech, '-ar', '16000', '-ac', '1', wav]);
command('/opt/homebrew/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x183f52:s=640x360:r=10', '-i', wav, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
let base;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.endsWith('.wav') || url.pathname.endsWith('.mp4')) {
    const file = url.pathname.endsWith('.wav') ? wav : mp4;
    const bytes = fs.readFileSync(file), match = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const first = match ? Number(match[1]) : 0, last = match && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
    response.writeHead(match ? 206 : 200, {'content-type': file === wav ? 'audio/wav' : 'video/mp4', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*',
      'content-length': last - first + 1, ...(match ? {'content-range': `bytes ${first}-${last}/${bytes.length}`} : {})});
    response.end(bytes.subarray(first, last + 1)); return;
  }
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  const single = url.pathname === '/asr' || url.pathname === '/live' || url.pathname === '/frame';
  const src = url.pathname === '/live' ? '' : url.pathname === '/asr' ? '/real.wav' : '/audio.wav';
  response.end(`<!doctype html><html><head><title>FluentRead HTML media</title><style>body{font:16px system-ui;background:#f4f6fa;color:#19252f;margin:32px auto;max-width:800px;padding:0 24px}audio{width:min(100%,640px)}video{width:min(100%,640px);height:auto}section{margin-bottom:180px}iframe{width:700px;height:500px;border:1px solid #ccd3db}</style></head><body><h1>HTML media learning</h1><section><h2>Podcast / lecture</h2><audio controls${src ? ` src="${src}"` : ''}></audio></section>${single ? '' : '<section><h2>Standard video</h2><video controls src="/video.mp4"></video></section><iframe src="/frame"></iframe>'}<p>Original page content remains in its own layout.</p></body></html>`);
});
const diagnostics = createRuntimeDiagnostics();
const result = {ok: false, realAsr, evidence: 'Production extension, local HTML media fixtures, seeded transcript UI and deterministic translation; real ASR only when explicitly enabled', checks: []};
let session, control, primaryError, testPage;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-html-media-'));
async function patch(config) {
  const stored = await control.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
  const previous = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value || {};
  const saved = await control.evaluate(({config, previous}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config,
    expected: Object.fromEntries(Object.keys(config).map(key => [key, previous[key]])), clientId: crypto.randomUUID(), sequence: 1}), {config, previous});
  assert.equal(saved.success, true);
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  session = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    background: true, headless: false, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
    browserArgs: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required']});
  const context = session.context;
  Object.assign(result, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
  await diagnostics.start(context);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = new URL(worker.url()).origin === 'null' ? worker.url().split('/').slice(0, 3).join('/') : new URL(worker.url()).origin;
  diagnostics.setExtensionId(new URL(worker.url()).host);
  control = await newPageWithoutForeground(context); await diagnostics.attachPage(control, 'extension-control');
  await control.goto(origin + '/popup.html');
  await patch({on: true, uiLanguage: 'en-US', uiLanguageSetupCompleted: true, from: 'en', to: 'zh-Hans',
    videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', videoSourceLanguage: 'auto',
    videoLocalModel: 'tiny', videoTranscriptionProvider: 'browser', videoService: 'microsoft', videoServiceDefaultMigrated: true,
    autoTranslate: false, floatingBall: false});
  await worker.evaluate(() => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.htmlMediaAsrCalls = 0;
    chrome.runtime.onMessage.addListener(message => {if (message.type === 'fluentReadTranscribeLocalVideoAudio') globalThis.htmlMediaAsrCalls++;});
    globalThis.fetch = async (input, init) => {
      if (!String(input?.url || input).startsWith('https://edge.microsoft.com/translate/translatetext')) return original(input, init);
      return new Response(JSON.stringify(JSON.parse(init.body).map(item => ({translations: [{text: '音视频学习测试译文', to: 'zh-Hans'}]}))), {headers: {'content-type': 'application/json'}});
    };
  });
  for (const [source, text] of [['/audio.wav', 'Learning from a standard audio player.'], ['/video.mp4', 'Learning from a standard video player.']]) {
    const mediaId = 'html:' + createHash('sha256').update(base + source).digest('hex');
    const seeded = await control.evaluate(({mediaId, text}) => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache', source: {mediaId}, model: 'tiny', videoSourceLanguage: 'auto',
      cues: [{startMs: 0, durationMs: 30000, text}]}), {mediaId, text});
    assert.equal(seeded.cached, true);
  }
  const page = await newPageWithoutForeground(context); testPage = page; await diagnostics.attachPage(page, 'html-media');
  await page.goto(base + '/');
  const button = page.locator('#fluent-read-video-subtitle-button');
  await button.waitFor({state: 'visible'});
  await page.locator('#fluent-read-video-subtitle-original').filter({hasText: 'standard audio'}).waitFor();
  assert.match(await page.locator('#fluent-read-video-subtitle').innerText(), /测试译文/);
  const audioBox = await page.locator('audio').boundingBox(); const host = await page.locator('.fluent-read-html-media-host').boundingBox();
  assert(host.y >= audioBox.y + audioBox.height - 1, 'Audio subtitles belong below native controls');
  await page.screenshot({path: path.join(artifacts, 'audio-desktop.png')}); result.checks.push('audio cached bilingual captions');
  await button.click();
  await page.locator('[data-action="open-sentence-learning"]').click();
  await page.locator('#fluent-read-video-learning-panel').waitFor({state: 'visible'});
  await page.locator('.fr-video-learning-word').first().click();
  await page.locator('[data-learning-word-popup]').waitFor({state: 'visible'});
  await page.keyboard.press('Escape');
  assert(await page.locator('#fluent-read-video-learning-panel').isVisible());
  await page.locator('.fr-video-learning-transcript summary').click();
  await page.locator('.fr-video-learning-transcript-scroll button').first().click();
  await page.screenshot({path: path.join(artifacts, 'audio-learning.png')});
  result.checks.push('word lookup popup and virtual transcript seeking');
  await page.keyboard.press('Escape'); result.checks.push('interactive transcript opens');
  if (!(await page.locator('#fluent-read-video-subtitle-menu').isVisible())) await button.click();
  await page.locator('[data-action="open-subtitle-tools"]').click();
  await page.locator('[data-action="toggle-subtitle-downloads"]').click();
  for (const format of ['srt', 'vtt', 'md']) {
    await page.locator('[data-subtitle-format]').selectOption(format);
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="download-subtitles"]').click();
    const download = await pending; assert(download.suggestedFilename().endsWith('.' + format));
    const target = path.join(artifacts, 'original.' + format); await download.saveAs(target);
    assert.match(fs.readFileSync(target, 'utf8'), /standard audio/); result.checks.push('export ' + format);
  }
  await page.locator('[data-action="close-menu"]').click();
  await page.locator('video').scrollIntoViewIfNeeded();
  await page.locator('video').evaluate(media => media.play());
  await page.locator('#fluent-read-video-subtitle-original').filter({hasText: 'standard video'}).waitFor();
  await page.locator('video').evaluate(media => media.pause());
  await page.screenshot({path: path.join(artifacts, 'video-desktop.png')}); result.checks.push('latest playing media selected');
  const frame = page.frameLocator('iframe'); await page.locator('iframe').scrollIntoViewIfNeeded();
  await frame.locator('#fluent-read-video-subtitle-button').waitFor({state: 'visible'});
  await frame.locator('#fluent-read-video-subtitle-original').filter({hasText: 'standard audio'}).waitFor();
  result.checks.push('embedded frame audio');
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('audio').scrollIntoViewIfNeeded(); await page.locator('audio').click(); await button.click();
  const menuBox = await page.locator('#fluent-read-video-subtitle-menu').boundingBox();
  assert(menuBox.x >= -1 && menuBox.x + menuBox.width <= 391, 'Menu stays inside narrow viewport');
  await page.screenshot({path: path.join(artifacts, 'audio-narrow-menu.png')}); result.checks.push('narrow menu');
  await patch({videoTranslationEnabled: false});
  await page.locator('#fluent-read-video-subtitle-button').waitFor({state: 'detached'});
  assert.equal(await page.locator('audio').evaluate(media => media.parentElement.tagName), 'SECTION'); result.checks.push('disable cleanup without moving media');
  if (realAsr) {
    await patch({videoTranslationEnabled: true});
    const asr = await newPageWithoutForeground(context); testPage = asr; await diagnostics.attachPage(asr, 'real-whisper-audio');
    await asr.goto(base + '/asr'); await asr.locator('audio').evaluate(media => media.play());
    await asr.locator('#fluent-read-video-subtitle-button').click();
    const prepared = await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: false}));
    result.modelPreparation = {success: prepared.success, error: prepared.error}; assert.equal(prepared.success, true, prepared.error);
    await asr.locator('[data-action="toggle-ai-subtitle"]').click();
    await asr.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.dataset.ready === 'true', null, {timeout: 180000});
    await asr.locator('audio').evaluate(media => {media.pause(); media.currentTime = 1;});
    await asr.waitForFunction(() => (document.querySelector('#fluent-read-video-subtitle-original')?.textContent || '').trim().length > 10, null, {timeout: 30000});
    const text = await asr.locator('#fluent-read-video-subtitle-original').innerText();
    assert.match(text, /audio|browser|learning|speech/i); result.realAsrTranscript = text;
    result.realAsrCalls = await worker.evaluate(() => globalThis.htmlMediaAsrCalls); assert(result.realAsrCalls > 0);
    await asr.screenshot({path: path.join(artifacts, 'real-whisper-audio.png')}); result.checks.push('real local Whisper from HTML audio');
    const live = await newPageWithoutForeground(context); testPage = live; await diagnostics.attachPage(live, 'real-whisper-stream');
    await live.goto(base + '/live');
    const duration = await live.evaluate(async () => {
      const context = new AudioContext(); const bytes = await (await fetch('/real.wav')).arrayBuffer();
      const buffer = await context.decodeAudioData(bytes); const source = context.createBufferSource(); source.buffer = buffer;
      const destination = context.createMediaStreamDestination(); source.connect(destination);
      const audio = document.querySelector('audio'); audio.srcObject = destination.stream; audio.volume = .5;
      globalThis.htmlMediaLive = {context, source}; await context.resume(); await audio.play(); return buffer.duration;
    });
    await live.waitForFunction(() => document.querySelector('audio').readyState >= 2 && !document.querySelector('audio').currentSrc);
    await live.locator('#fluent-read-video-subtitle-button').click(); await live.locator('[data-action="toggle-ai-subtitle"]').click();
    await live.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.getAttribute('aria-checked') === 'true');
    await live.waitForTimeout(250); await live.evaluate(() => globalThis.htmlMediaLive.source.start());
    await live.waitForTimeout(duration * 1000 + 350);
    if (!(await live.locator('#fluent-read-video-subtitle-menu').isVisible())) await live.locator('#fluent-read-video-subtitle-button').click();
    await live.locator('[data-action="toggle-ai-subtitle"]').click();
    if (!(await live.locator('#fluent-read-video-subtitle-menu').isVisible())) await live.locator('#fluent-read-video-subtitle-button').click();
    await live.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.dataset.ready === 'true', null, {timeout: 180000});
    const playback = await live.locator('audio').evaluate(audio => ({paused: audio.paused, volume: audio.volume,
      originalTracksLive: audio.srcObject.getAudioTracks().every(track => track.readyState === 'live')}));
    assert.deepEqual(playback, {paused: false, volume: .5, originalTracksLive: true});
    await live.locator('[data-action="open-subtitle-tools"]').click(); await live.locator('[data-action="toggle-subtitle-downloads"]').click();
    const pendingLive = live.waitForEvent('download'); await live.locator('[data-action="download-subtitles"]').click();
    const streamDownload = await pendingLive; assert(streamDownload.suggestedFilename().includes('partial'));
    const streamFile = path.join(artifacts, 'real-stream-partial.srt'); await streamDownload.saveAs(streamFile);
    assert.match(fs.readFileSync(streamFile, 'utf8'), /audio|browser|learning|speech/i);
    result.livePlayback = playback; result.checks.push('real MediaStream capture, partial export and untouched original audio');
    await live.evaluate(() => globalThis.htmlMediaLive.context.close());

  }
  await diagnostics.flush(); diagnostics.assertClean(); result.ok = true;
}
main().catch(async error => {primaryError = error; result.error = error.stack; process.exitCode = 1; if (testPage && !testPage.isClosed()) {await testPage.screenshot({path: path.join(artifacts, 'failure.png')}); fs.writeFileSync(path.join(artifacts, 'failure.html'), await testPage.content());}}).finally(async () => {
  await finalizeRun({diagnostics, result, artifactsDir: artifacts, primaryError,
    cleanup: [{stage: 'browser', action: async () => session?.close()}, {stage: 'server', action: async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}},
      {stage: 'profile', action: async () => fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 4, retryDelay: 250})}],
    emitReport: () => console.log(JSON.stringify({ok: result.ok, checks: result.checks, error: result.error, artifacts}))});
}).catch(error => {console.error(error); process.exitCode = 1;});
