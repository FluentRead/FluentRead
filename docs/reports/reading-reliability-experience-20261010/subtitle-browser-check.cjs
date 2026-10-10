#!/usr/bin/env node
// 固定 YouTube 页面/媒体与 loopback Microsoft 服务，验收生产扩展的字幕字号和导出确认；不访问真实字幕服务。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const project = path.resolve(__dirname, '../../..');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', path.join(project, '.output/chrome-mv3')));
const artifacts = path.resolve(arg('artifacts-dir', path.join(__dirname, 'subtitle-browser-evidence')));
const root = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
const playwright = createRequire(path.join(path.resolve(root), '__subtitle_browser_check__.cjs'))('playwright');
const focus = require(path.resolve(arg('focus-safe-helper', path.join(project, 'scripts/testing/focus-safe-browser.cjs'))));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-subtitle-reliability-'));
const assert = (condition, message, details) => {if (!condition) throw new Error(`${message}: ${JSON.stringify(details)}`);};
const short = 'Readable subtitle.';
const missing = ['First missing export sentence.', 'Second missing export sentence.'];
const long = 'This long bilingual subtitle must remain entirely inside the video viewport while the requested font scale stays at five hundred percent. '.repeat(4);
const requests = [], blocked = [], errors = [];
const result = {success: false, scope: 'production extension; offline YouTube/media + loopback Microsoft fixture; no live provider, Firefox or low-end hardware', extensionDir, profileDir, requests, blocked, errors, cases: {}, screenshots: []};
let session, server, control, testPage, sequence = 0;
async function readConfig() {return control.evaluate(async () => {
  const record = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
  if (!record?.success) throw new Error(record?.error || 'config read failed');
  return typeof record.value === 'string' ? JSON.parse(record.value) : record.value;
});}
async function configure(patch) {
  const current = await readConfig();
  const response = await control.evaluate(({current, patch, sequence}) => chrome.runtime.sendMessage({type: 'persistConfig', config: {...current, ...patch},
    clientId: 'subtitle-reliability-browser', sequence, baseRevision: current.__fluentConfigRevision}), {current, patch, sequence: ++sequence});
  assert(response?.success, 'fixture configuration failed', response);
}
async function screenshot(page, name) {const file = path.join(artifacts, name); await page.screenshot({path: file}); result.screenshots.push(file);}
async function main() {
  fs.mkdirSync(artifacts, {recursive: true});
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'extension build missing', extensionDir);
  const manifest = fs.readFileSync(path.join(extensionDir, 'manifest.json'));
  result.build = {manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'), contentScripts: JSON.parse(manifest).content_scripts?.flatMap(entry => entry.js || [])};
  const mediaFile = path.join(artifacts, 'fixture.mp4');
  const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], {encoding: 'utf8', timeout: 30000});
  assert(media.status === 0, 'fixture video generation failed', media.stderr);
  const videoSrc = `data:video/mp4;base64,${fs.readFileSync(mediaFile).toString('base64')}`;
  server = http.createServer(async (request, response) => {
    const headers = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json', 'cache-control': 'no-store'};
    if (request.method === 'OPTIONS') {response.writeHead(204, headers); response.end(); return;}
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    if (request.url !== '/microsoft') {blocked.push(body?.url || request.url); response.writeHead(502, headers); response.end('{}'); return;}
    const source = Array.isArray(body) ? String(body[0]) : '';
    requests.push(source);
    await new Promise(resolve => setTimeout(resolve, 120));
    response.writeHead(200, headers); response.end(JSON.stringify([{translations: [{text: source === short ? '清晰可读。' : source === long.trim() ? '这是一条很长的双语字幕，需要在百分之五百的偏好字号下完整保留在视频画面内。'.repeat(6) : `译文：${source}`}]}]));
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  session = await focus.launchFocusSafePersistentContext({chromium: playwright.chromium, profileDir,
    browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: false, background: true, displayTarget: 'secondary',
    viewport: {width: 1280, height: 900}, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
  Object.assign(result, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
  const context = session.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
  assert(extensionId, 'extension worker URL invalid', worker.url());
  const install = target => target.evaluate(origin => {
    if (globalThis.__subtitleReliabilityFixture) return;
    const native = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'edge.microsoft.com' && parsed.pathname === '/translate/translatetext') return native(`${origin}/microsoft`, init);
      if (/^https?:$/.test(parsed.protocol)) return native(`${origin}/unexpected`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({url}), signal: init?.signal});
      return native(input, init);
    };
    globalThis.__subtitleReliabilityFixture = true;
  }, origin);
  await install(worker); context.on('serviceworker', target => void install(target).catch(error => errors.push(error.message)));
  worker.on('console', msg => {if (msg.type() === 'error') errors.push(msg.text());});
  const createPage = async url => {const page = await focus.newPageWithoutForeground(context); await page.goto(url, {waitUntil: 'domcontentloaded'}); return page;};
  control = await createPage(`chrome-extension://${extensionId}/options.html#settings-video`);
  await control.locator('#settings-video').waitFor({state: 'visible'});
  const initial = await readConfig();
  await configure({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, from: 'auto', to: 'zh-Hans', videoTranslationEnabled: true,
    videoService: 'microsoft', videoServiceDefaultMigrated: true, videoPreferHumanSubtitles: false, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', useCache: false,
    videoSubtitleAppearance: {...initial.videoSubtitleAppearance, fontScale: 140}});
  await control.reload({waitUntil: 'domcontentloaded'});
  const number = control.locator('[data-video-subtitle-appearance] input[type="number"]');
  await number.fill('437'); await number.press('Tab');
  await control.waitForFunction(async () => {const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); const c = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; return c.videoSubtitleAppearance.fontScale === 437;});
  await control.reload({waitUntil: 'domcontentloaded'});
  assert(await number.inputValue() === '437', 'custom font percentage did not survive reload');
  await number.fill('500'); await number.press('Tab');
  await control.waitForFunction(async () => {const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); const c = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; return c.videoSubtitleAppearance.fontScale === 500;});
  result.cases.numericPersistence = {custom: 437, reloaded: true, final: 500};
  await screenshot(control, 'numeric-500.png');
  const url = 'https://www.youtube.com/watch?v=subtitle-reliability';
  const events = [{tStartMs: 0, dDurationMs: 1500, segs: [{utf8: short}]},
    {tStartMs: 120000, dDurationMs: 1500, segs: [{utf8: missing[0]}]}, {tStartMs: 122000, dDurationMs: 1500, segs: [{utf8: missing[1]}]},
    {tStartMs: 124000, dDurationMs: 1500, segs: [{utf8: missing[0]}]}];
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.origin === origin) {await route.continue(); return;}
    if (target.hostname === 'www.youtube.com' && target.pathname === '/watch') {
      await route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Subtitle reliability fixture</title><script>var ytInitialPlayerResponse=${JSON.stringify({captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=subtitle-reliability&lang=en',languageCode:'en'}]}}})};</script></head><body><div id="movie_player" class="html5-video-player"></div></body></html>`}); return;
    }
    if (target.hostname === 'www.youtube.com' && target.pathname === '/api/timedtext') {await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({events})}); return;}
    if (/^https?:$/.test(target.protocol)) {blocked.push(target.href); await route.abort(); return;}
    await route.continue();
  });
  const page = await createPage(url);
  testPage = page;
  page.on('pageerror', error => errors.push(error.message));
  await focus.activateExtensionTabWithoutForeground(context, page);
  await page.evaluate(videoSrc => {
    const player = document.querySelector('#movie_player');
    player.style.cssText = 'position:fixed;left:24px;top:24px;width:960px;height:540px;background:linear-gradient(135deg,#172033,#020617);overflow:hidden';
    player.innerHTML = '<video class="html5-main-video" muted style="position:absolute;width:1px;height:1px;opacity:0"></video><div id="ytp-caption-window-container" style="position:absolute;left:0;right:0;top:65%;height:20%;text-align:center;color:white;font:600 20px/1.35 Arial"><span class="ytp-caption-segment"></span></div><div class="ytp-right-controls" style="position:absolute;right:20px;bottom:10px;height:48px"><button class="ytp-settings-button">⚙</button></div>';
    const video = player.querySelector('video'); video.src = videoSrc; video.load();
  }, videoSrc);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1 && document.querySelector('#fluent-read-video-subtitle-button'));
  await page.evaluate(short => {document.querySelector('.ytp-caption-segment').textContent = short;}, short);
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent.includes('清晰可读'));
  const geometry = () => page.evaluate(() => {
    const panel = document.querySelector('#fluent-read-video-subtitle-panel'), overlay = document.querySelector('#fluent-read-video-subtitle');
    const player = document.querySelector('#movie_player'); const p = panel.getBoundingClientRect(), r = player.getBoundingClientRect();
    return {font: parseFloat(getComputedStyle(overlay).fontSize), panel: p.toJSON(), player: r.toJSON(), scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      inside: p.left >= r.left - 1 && p.right <= r.right + 1 && p.top >= r.top - 1 && p.bottom <= r.bottom + 1 && panel.scrollHeight <= panel.clientHeight + 1};
  });
  result.cases.short500 = await geometry(); assert(result.cases.short500.font >= 70 && result.cases.short500.inside, 'short subtitle not large/contained', result.cases.short500);
  await screenshot(page, 'short-500.png');
  await page.evaluate(async () => {await fetch('https://www.youtube.com/api/timedtext?v=subtitle-reliability&lang=en').then(response => response.text());});
  await page.waitForTimeout(400);
  await page.evaluate(long => {document.querySelector('video').currentTime = 5; document.querySelector('.ytp-caption-segment').textContent = long;}, long);
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent.includes('这是一条很长'));
  result.cases.long500 = await geometry(); assert(result.cases.long500.inside, 'long bilingual subtitle escaped player', result.cases.long500);
  assert((await readConfig()).videoSubtitleAppearance.fontScale === 500, 'automatic fit mutated preference');
  await screenshot(page, 'long-500.png');
  await page.locator('#fluent-read-video-subtitle-button').press('Enter');
  const menu = page.locator('#fluent-read-video-subtitle-menu');
  const translated = menu.locator('[data-action="download-translated-subtitles"]');
  const preview = async () => {
    if (!await menu.isVisible()) await page.locator('#fluent-read-video-subtitle-button').press('Enter');
    await page.waitForFunction(() => !document.querySelector('[data-action="download-translated-subtitles"]').disabled, null, {timeout: 5000});
    await translated.press('Enter'); await menu.locator('[data-export-prompt]').waitFor({state: 'visible'}); return menu.locator('[data-export-prompt]').textContent();
  };
  const before = requests.length;
  const previewText = await preview();
  assert(previewText.includes('共 4 条') && previewText.includes('可直接导出 1 条') && previewText.includes('待补译 3 条') && previewText.includes('最多新增 2 个') && previewText.includes('00:02:00'), 'export gap preview incorrect', previewText);
  await screenshot(page, 'export-preview.png');
  await menu.locator('[data-export-choice="cancel"]').press('Enter'); await page.waitForTimeout(300);
  assert(requests.length === before, 'cancel sent completion requests', requests); result.cases.cancel = {previewText, extraRequests: 0};
  await translated.waitFor({state: 'visible'}); await page.waitForTimeout(2300);
  await preview();
  const partialEvent = page.waitForEvent('download'); await menu.locator('[data-export-choice="existing"]').press('Enter');
  const partial = await partialEvent; const partialPath = path.join(artifacts, partial.suggestedFilename()); await partial.saveAs(partialPath);
  const partialText = fs.readFileSync(partialPath, 'utf8');
  assert(partial.suggestedFilename().includes('-partial.srt') && partialText.includes('清晰可读') && !partialText.includes(missing[0]) && requests.length === before, 'existing-result download is not explicit partial', {filename: partial.suggestedFilename(), partialText, requests});
  result.cases.partial = {filename: partial.suggestedFilename(), content: partialText, extraRequests: 0, skipped: 3};
  await page.waitForTimeout(2300); await preview();
  const completeEvent = page.waitForEvent('download'); await menu.locator('[data-export-choice="complete"]').press('Enter');
  const complete = await completeEvent; const completePath = path.join(artifacts, complete.suggestedFilename()); await complete.saveAs(completePath);
  const completeText = fs.readFileSync(completePath, 'utf8'), added = requests.slice(before);
  assert(added.length === 2 && new Set(added).size === 2 && missing.every(source => added.includes(source)) && !complete.suggestedFilename().includes('partial') && completeText.includes('00:02:04,000') && (completeText.match(/^\d+$/gm) || []).length === 4, 'complete export request/timeline mismatch', {added, completeText});
  result.cases.complete = {filename: complete.suggestedFilename(), content: completeText, extraRequests: added.length, uniqueSources: added};
  await screenshot(page, 'complete-feedback.png');
  await page.waitForTimeout(2300); await preview();
  const beforeMediaChange = requests.length;
  await page.evaluate(() => {document.querySelector('video').src += '#new-media';});
  await menu.locator('[data-export-prompt]').waitFor({state: 'detached'});
  await page.waitForFunction(() => !document.querySelector('[data-action="download-translated-subtitles"]')?.hasAttribute('aria-busy'));
  assert(requests.length === beforeMediaChange, 'same-URL media change sent old completion requests', requests);
  result.cases.mediaChange = {samePageUrl: page.url() === url, oldPromptRemoved: true, busyCleared: true, extraRequests: 0};
  assert(blocked.length === 0, 'fixture attempted unexpected external network', blocked);
  assert(result.launchMode === 'macos-background-cdp' && result.focusPolicy === 'launchservices-no-foreground' && result.windowPlacement.mode === 'background-visible-no-focus' && result.windowPlacement.browserFrontmost === false, 'focus-safe evidence invalid', result.windowPlacement);
  result.success = true;
}
main().catch(async error => {
  result.error = error.stack; process.exitCode = 1;
  if (testPage && !testPage.isClosed()) {
    result.failureDom = await testPage.evaluate(() => ({menu: document.querySelector('#fluent-read-video-subtitle-menu')?.outerHTML, video: document.querySelector('video')?.outerHTML}));
    await screenshot(testPage, 'failure.png');
  }
}).finally(async () => {
  if (session) await session.close().catch(error => errors.push(error.message));
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(profileDir, {recursive: true, force: true});
  fs.mkdirSync(artifacts, {recursive: true}); fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
});
