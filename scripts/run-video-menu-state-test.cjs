#!/usr/bin/env node
// Production-extension regression for X control placement and menu state across remounts.
// Uses seeded transcript cues and a deterministic translation response, not live ASR.
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
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-video-menu-state'));
const helperPath = arg('focus-safe-helper');
const playwrightRoot = arg('playwright-root');
if (!helperPath || !playwrightRoot) throw new Error('Explicit focus-safe helper and Playwright runtime are required');
const helper = require(path.resolve(helperPath));
const {chromium} = createRequire(path.join(playwrightRoot, 'video-menu-proof.cjs'))('playwright');
fs.mkdirSync(artifacts, {recursive: true});
const mediaFile = path.join(artifacts, 'fixture.mp4');
const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x10283f:s=960x540:r=10',
  '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile,
], {encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL'});
assert.equal(media.status, 0, media.stderr);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-menu-state-'));
const report = {success: false, evidence: 'Production extension; X DOM fixture; seeded AI cache; mocked translation; no live ASR', checks: [], errors: []};
let session;
let page;
async function main() {
  session = await helper.launchFocusSafePersistentContext({
    chromium, profileDir,
    browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    headless: false, background: true, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
  });
  const {context} = session;
  Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
  context.on('page', candidate => candidate.on('pageerror', error => report.errors.push(error.message)));
  const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith('/background.js'))
    || await context.waitForEvent('serviceworker', {predicate: candidate => candidate.url().endsWith('/background.js')});
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fixtureTranslationCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input?.url || input).startsWith('https://edge.microsoft.com/translate/translatetext')) return originalFetch(input, init);
      globalThis.fixtureTranslationCalls += 1;
      if (globalThis.fixtureTranslationFails) return new Response(JSON.stringify([{translations: [{text: ''}]}]), {status: 200, headers: {'content-type': 'application/json'}});
      return new Response(JSON.stringify([{translations: [{text: '字幕菜单同步测试'}]}]), {status: 200, headers: {'content-type': 'application/json'}});
    };
  });
  const control = await helper.newPageWithoutForeground(context);
  await control.goto(`chrome-extension://${id}/popup.html`);
  let sequence = 0;
  const patchConfig = async patch => {
    const response = await control.evaluate(async ({patch, sequence}) => {
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!stored.success) throw new Error('Cannot read fixture configuration');
      const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value || {};
      return chrome.runtime.sendMessage({type: 'persistConfig', clientId: 'video-menu-state-proof', sequence,
        config: {...current, ...patch}, ...(Number.isSafeInteger(current.__fluentConfigRevision) ? {baseRevision: current.__fluentConfigRevision} : {})});
    }, {patch, sequence: ++sequence});
    assert.equal(response.success, true);
  };
  await patchConfig({on: true, uiLanguage: 'zh-CN', from: 'en', to: 'zh-Hans',
    videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual',
    videoService: 'microsoft', videoServiceDefaultMigrated: true, videoLocalModel: 'tiny', videoSourceLanguage: 'auto'});
  const cached = await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
    source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'auto',
    cues: [{startMs: 0, durationMs: 10000, text: 'Subtitle menu state fixture.'}]}));
  assert.equal(cached.cached, true);
  const url = 'https://x.com/fluentread/status/424242';
  await context.route('https://video.twimg.com/**', route => {
    const bytes = fs.readFileSync(mediaFile);
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return route.fulfill({contentType: 'video/mp4', headers: {'accept-ranges': 'bytes'}, body: bytes});
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({status: 206, contentType: 'video/mp4',
      headers: {'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`},
      body: bytes.subarray(start, end + 1)});
  });
  await context.route(url, route => route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>
    .fixture-controls{position:absolute;bottom:0;left:12px;right:12px;display:flex;align-items:center;height:44px;background:#222;color:#fff}
    .fixture-controls button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;padding:0;border:0;background:transparent;color:#fff;font-size:20px}
    .fixture-time{flex:1;min-width:0;font:12px Arial;white-space:nowrap;overflow:hidden}
    .fixture-actions{display:flex;align-items:center;flex:none}
    [data-testid="videoPlayer"]:fullscreen{width:100vw!important;height:100vh!important}
    </style></head><body style="margin:24px;background:#f3f5f9">
    <h1>字幕菜单状态同步</h1><article><div data-testid="videoPlayer" style="position:relative;width:960px;height:540px;overflow:hidden">
    <video src="https://video.twimg.com/ext_tw_video/424242/pu/fixture.mp4" style="width:100%;height:100%" muted></video>
    <div class="fixture-controls"><button aria-label="Play" onclick="this.dataset.clicked='true'">▶</button><span class="fixture-time">0:02 / 0:13</span>
    <div class="fixture-actions"><button aria-label="Captions">▣</button><button aria-label="Volume">◖</button><button aria-label="Settings">⚙</button>
    <div id="fixture-pip"><button aria-label="Picture in picture" onclick="this.dataset.clicked='true'">▣</button></div>
    <div id="fixture-fullscreen"><button aria-label="Full screen" onclick="this.closest('[data-testid=videoPlayer]').requestFullscreen()">⛶</button></div>
    </div></div></div></article></body></html>`}));
  page = await helper.newPageWithoutForeground(context);
  await page.goto(url);
  await helper.activateExtensionTabWithoutForeground({serviceWorkers: () => [worker]}, page);
  await page.locator('video').hover();
  const checkPlacement = async name => {
    await page.waitForFunction(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-button');
      return button?.previousElementSibling?.id === 'fixture-pip' && button?.nextElementSibling?.id === 'fixture-fullscreen';
    });
    const geometry = await page.evaluate(() => {
      const rect = element => {
        const {left, right, top, bottom, width, height} = element.getBoundingClientRect();
        return {left, right, top, bottom, width, height};
      };
      return {
        player: rect(document.querySelector('[data-testid="videoPlayer"]')),
        video: rect(document.querySelector('video')),
        button: rect(document.querySelector('#fluent-read-video-subtitle-button')),
        pip: rect(document.querySelector('#fixture-pip')),
        fullscreen: rect(document.querySelector('#fixture-fullscreen')),
        count: document.querySelectorAll('#fluent-read-video-subtitle-button').length,
      };
    });
    assert.equal(geometry.count, 1);
    assert.ok(geometry.button.width > 0 && geometry.button.height > 0);
    assert.ok(geometry.button.left >= geometry.pip.right - 1 && geometry.button.right <= geometry.fullscreen.left + 1, JSON.stringify(geometry));
    for (const control of [geometry.pip, geometry.button, geometry.fullscreen]) {
      assert.ok(control.left >= geometry.video.left && control.right <= geometry.video.right && control.bottom <= geometry.video.bottom, JSON.stringify(geometry));
    }
    (report.placement ||= []).push({name, ...geometry});
  };
  for (const width of [960, 572, 360, 320]) {
    await page.locator('[data-testid="videoPlayer"]').evaluate((player, width) => player.style.width = width + 'px', width);
    await checkPlacement(`width-${width}`);
  }
  await page.locator('[data-testid="videoPlayer"]').screenshot({path: path.join(artifacts, 'portrait-controls.png')});
  await page.locator('[aria-label="Play"]').click();
  await page.locator('#fixture-pip button').click();
  assert.equal(await page.locator('[aria-label="Play"]').getAttribute('data-clicked'), 'true');
  assert.equal(await page.locator('#fixture-pip button').getAttribute('data-clicked'), 'true');
  await page.evaluate(() => document.querySelector('.fixture-actions').append(document.querySelector('#fluent-read-video-subtitle-button')));
  await checkPlacement('host-moved-icon');
  await page.evaluate(() => document.querySelector('#fluent-read-video-subtitle-button').remove());
  await checkPlacement('host-removed-icon');
  await page.locator('#fixture-fullscreen button').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.locator('#fixture-fullscreen button').evaluate(button => button.setAttribute('aria-label', 'Exit full screen'));
  await checkPlacement('fullscreen');
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await checkPlacement('exit-fullscreen');
  await page.evaluate(() => {
    const actions = document.querySelector('.fixture-actions');
    const replacement = actions.cloneNode(true);
    replacement.querySelector('#fluent-read-video-subtitle-button')?.remove();
    actions.replaceWith(replacement);
  });
  await checkPlacement('controls-replaced');
  await page.locator('[data-testid="videoPlayer"]').evaluate(player => player.style.width = '960px');
  report.checks.push('320–960px 视频内图标固定在画中画和全屏之间；宿主移位/删除、控件重建、全屏进出后恢复，原生按钮仍可点击');
  const menu = page.locator('#fluent-read-video-subtitle-menu');
  const action = name => menu.locator(`[data-action="${name}"]`);
  const clickAction = async name => {
    if (!(await action(name).isVisible())) {
      const inTools = await action(name).evaluate(button => Boolean(button.closest('.fluent-read-video-menu-tools')));
      await action(inTools ? 'open-subtitle-tools' : 'close-subtitle-tools').click();
    }
    await action(name).click();
  };
  const checked = async (locator, expected) => {
    await locator.evaluate((element, value) => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => element.getAttribute('aria-checked') === String(value) ? resolve()
        : Date.now() - started > 2500 ? reject(new Error(`Stale menu: ${element.dataset.action || element.dataset.mode} expected ${value}; got ${element.outerHTML}`))
          : setTimeout(poll, 25);
      poll();
    }), expected);
  };
  const screenshot = async name => {
    await menu.screenshot({path: path.join(artifacts, `${name}.png`)});
    fs.writeFileSync(path.join(artifacts, `${name}.html`), await menu.evaluate(element => element.outerHTML));
  };
  const checkCompactState = async name => {
    const player = page.locator('[data-testid="videoPlayer"]');
    const previous = await player.getAttribute('style');
    await player.evaluate(node => { node.style.width = '390px'; node.style.height = '220px'; });
    const geometry = await menu.evaluate(node => ({width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height, scrolls: node.scrollHeight > node.clientHeight + 1,
      overflowX: node.scrollWidth > node.clientWidth + 1}));
    await player.screenshot({path: path.join(artifacts, `${name}-small.png`)});
    assert.ok(geometry.width <= 280 && geometry.height <= 172 && !geometry.scrolls && !geometry.overflowX, JSON.stringify({name, ...geometry}));
    (report.compactStates ||= []).push({name, ...geometry});
    await player.evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), previous);
  };
  await page.locator('#fluent-read-video-subtitle-button').click();
  await checked(action('toggle-ai-subtitle'), true);
  await screenshot('ready');
  assert.equal(await action('toggle-ai-subtitle').isVisible(), false);
  assert.equal(await action('download-subtitles').isVisible(), false);
  assert.equal(await action('regenerate-ai-subtitle').isVisible(), false);
  await action('open-subtitle-tools').click();
  assert.equal(await action('download-subtitles').isVisible(), true);
  assert.equal(await action('regenerate-ai-subtitle').isVisible(), true);
  await screenshot('subtitle-options');
  await menu.press('Escape');
  assert.equal(await menu.isVisible(), true);
  assert.equal(await action('open-subtitle-tools').evaluate(node => node === document.activeElement), true);
  report.checks.push('观看首页隐藏重复关闭和导出，字幕选项可访问校时、下载、重新识别，Esc 返回并恢复焦点');
  await page.evaluate(() => {
    window.fixtureControls = document.querySelector('.fixture-controls');
    window.fixtureMenu = document.querySelector('#fluent-read-video-subtitle-menu');
    window.fixtureControls.remove();
  });
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-button'));
  await clickAction('toggle-ai-subtitle');
  await screenshot('after-close-ai');
  await checked(action('toggle-ai-subtitle'), false);
  assert.match(await action('toggle-ai-subtitle').innerText(), /生成 AI 字幕/);
  assert.equal(await action('toggle-ai-subtitle').locator('[data-state]').innerText(), '');
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-original')?.textContent);
  report.checks.push('关闭 AI 后字幕消失，按钮和已就绪状态立即更新');
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), true);
  const modes = ['bilingual', 'translation-only', 'original-only', 'off'];
  const checkedMode = async selected => {
    for (const candidate of modes) await checked(menu.locator(`[data-mode="${candidate}"]`), candidate === selected);
  };
  assert.equal(await menu.locator('[data-action="toggle-translation"], [data-action="toggle-visible"]').count(), 0);
  for (const mode of ['translation-only', 'original-only', 'bilingual']) {
    await menu.locator(`[data-mode="${mode}"]`).click();
    await checkedMode(mode);
    await page.waitForFunction(selected => {
      const layer = document.querySelector('#fluent-read-video-subtitle-layer');
      return layer && ['translation-only', 'original-only'].every(candidate =>
        layer.classList.contains(`fluent-read-video-display-${candidate}`) === (selected === candidate));
    }, mode);
  }
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent === '字幕菜单同步测试');
  const beforeModeToggle = await worker.evaluate(() => globalThis.fixtureTranslationCalls);
  await menu.locator('[data-mode="original-only"]').click();
  await menu.locator('[data-mode="bilingual"]').click();
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent === '字幕菜单同步测试');
  assert.equal(await worker.evaluate(() => globalThis.fixtureTranslationCalls), beforeModeToggle);
  report.checks.push('四段显示方式同步且保持单选；原文与双语切换保留已完成译文，不重复请求');
  await menu.locator('[data-mode="off"]').click();
  await checkedMode('off');
  await checked(action('toggle-ai-subtitle'), false);
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-original')?.textContent);
  assert.equal(await menu.locator('[data-timing-row]').isVisible(), false);
  await screenshot('off');
  await menu.locator('[data-mode="bilingual"]').click();
  await checkedMode('bilingual');
  await checked(action('toggle-ai-subtitle'), true);
  report.checks.push('“关闭”停止 AI 并收起时间行，重新选择显示方式后恢复缓存字幕');
  await patchConfig({videoSubtitleVisible: false, videoSubtitleDisplayMode: 'original-only'});
  await checkedMode('off');
  await menu.locator('[data-mode="original-only"]').click();
  await checkedMode('original-only');
  await page.waitForFunction(() => {
    const layer = document.querySelector('#fluent-read-video-subtitle-layer');
    return layer && !layer.classList.contains('fluent-read-video-display-hidden');
  });
  await patchConfig({videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual'});
  await checkedMode('bilingual');
  report.checks.push('其他页面隐藏字幕时菜单显示为关闭，选择任一显示方式即恢复可见');
  // 在扩展隔离世界里按消息类型伪造后台响应：不下载模型，也不运行语音识别。
  const probe = await context.newCDPSession(page);
  const worlds = [];
  probe.on('Runtime.executionContextCreated', event => worlds.push(event.context));
  await probe.send('Runtime.enable');
  let world;
  for (const candidate of worlds.filter(candidate => candidate.auxData?.isDefault === false)) {
    const identity = await probe.send('Runtime.evaluate', {contextId: candidate.id, returnByValue: true,
      expression: 'globalThis.chrome?.runtime?.id'});
    if (identity.result?.value === id) { world = candidate; break; }
  }
  assert.ok(world, 'FluentRead isolated world is available');
  const fakeResponses = responses => probe.send('Runtime.evaluate', {contextId: world.id, expression: `(() => {
    const runtime = chrome.runtime;
    const send = runtime.__fixtureSend || runtime.sendMessage;
    runtime.__fixtureSend = send;
    const queue = ${JSON.stringify(responses)};
    runtime.sendMessage = function(...args) {
      const responses = queue[args[0]?.type];
      if (!responses?.length) return send.apply(runtime, args);
      const response = responses.shift();
      const callback = args[args.length - 1];
      if (typeof callback === 'function') { queueMicrotask(() => callback(response)); return; }
      return Promise.resolve(response);
    };
  })()`});
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), false);
  const cleared = await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadClearVideoAiSubtitleCache'}));
  assert.equal(cleared.success, true);
  await fakeResponses({fluentReadGetLocalVideoModelState: [{success: false, error: 'fixture readiness failure'}]});
  await clickAction('toggle-ai-subtitle');
  await page.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.title === '无法读取模型状态，请重试');
  assert.match(await action('toggle-ai-subtitle').innerText(), /重试生成 AI 字幕/);
  report.checks.push('模型状态读取失败时单行显示错误并允许重试');
  await fakeResponses({
    fluentReadGetLocalVideoModelState: [{success: true, models: []}, {success: true, models: []}],
    fluentReadPrepareLocalVideoModel: [{success: false, error: '模型文件下载失败（503）：config.json'}],
  });
  await clickAction('toggle-ai-subtitle');
  const prompt = menu.locator('[data-model-prompt]');
  await prompt.waitFor({state: 'visible'});
  assert.equal(await menu.locator('.fluent-read-video-menu-main').isVisible(), false);
  assert.match(await prompt.innerText(), /约 100 MB[\s\S]*约 150 MB/);
  assert.equal(await prompt.locator('.fluent-read-video-model-option-badge').count(), 1);
  await screenshot('model-prompt');
  const optionsPage = [];
  context.on('page', candidate => optionsPage.push(candidate.url()));
  await prompt.locator('[data-action="model-prompt-cancel"]').first().click();
  await prompt.waitFor({state: 'hidden'});
  assert.equal(await menu.locator('.fluent-read-video-menu-main').isVisible(), true);
  await clickAction('toggle-ai-subtitle');
  await prompt.waitFor({state: 'visible'});
  await prompt.locator('[data-model-choice="tiny"]').click();
  await checked(prompt.locator('[data-model-choice="tiny"]'), true);
  assert.equal(await prompt.locator('[data-action="model-prompt-confirm"]').innerText(), '下载并生成');
  await prompt.locator('[data-action="model-prompt-confirm"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.title?.startsWith('模型下载失败：'));
  assert.deepEqual(optionsPage.filter(url => url.includes('options.html')), []);
  report.checks.push('首次生成先在菜单内确认模型与大小，取消可返回，确认后下载失败给出单行错误且不跳转设置页');
  const reseeded = await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
    source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'auto',
    cues: [{startMs: 0, durationMs: 10000, text: 'Subtitle menu state fixture.'}]}));
  assert.equal(reseeded.cached, true);
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), true);
  report.checks.push('缓存命中时直接恢复 AI 字幕，不弹出模型确认');
  await page.waitForFunction(() => document.querySelector('[data-source-status]')?.textContent.includes('本地字幕'));
  await fakeResponses({fluentReadGetLocalVideoModelState: [{success: true, models: []}]});
  await clickAction('regenerate-ai-subtitle');
  await prompt.waitFor({state: 'visible'});
  assert.match(await page.locator('#fluent-read-video-subtitle-original').textContent(), /Subtitle menu/);
  await prompt.locator('[data-action="model-prompt-cancel"]').first().click();
  await checked(action('toggle-ai-subtitle'), true);
  report.checks.push('重新识别绕过当前视频缓存；模型确认前保留现有字幕，取消后仍可观看');
  await probe.detach();
  for (const name of ['download-subtitles', 'download-translated-subtitles', 'download-bilingual-subtitles']) {
    const downloaded = page.waitForEvent('download');
    await clickAction(name);
    const download = await downloaded;
    const destination = path.join(artifacts, `${name}.srt`);
    await download.saveAs(destination);
    const srt = fs.readFileSync(destination, 'utf8');
    assert.match(srt, /00:00:00,000 --> 00:00:10,000/);
    assert.match(await menu.locator('[data-download-status]').innerText(), /1/);
    (report.downloads ||= {})[name] = {filename: download.suggestedFilename(), body: srt.trim()};
  }
  assert.match(report.downloads['download-subtitles'].body, /Subtitle menu state fixture\.$/u);
  assert.match(report.downloads['download-translated-subtitles'].body, /字幕菜单同步测试$/u);
  // 双语文件把原文与译文放在同一条 cue 的两行里。
  assert.match(report.downloads['download-bilingual-subtitles'].body, /Subtitle menu state fixture\.\n字幕菜单同步测试$/u);
  assert.ok(report.downloads['download-bilingual-subtitles'].filename.endsWith('-bilingual.srt'), report.downloads['download-bilingual-subtitles'].filename);
  report.checks.push('原文、译文和双语下载及结果反馈正常，双语文件保留两行');
  await screenshot('controls-absent');
  await action('close-subtitle-tools').click();
  await page.evaluate(() => document.querySelector('[data-testid="videoPlayer"]').append(window.fixtureControls));
  await page.locator('#fluent-read-video-subtitle-button').waitFor({state: 'attached'});
  await checkPlacement('controls-restored');
  assert.equal(await page.evaluate(() => window.fixtureMenu === document.querySelector('#fluent-read-video-subtitle-menu')), true);
  await page.locator('#fluent-read-video-subtitle-button').click();
  if (!(await menu.isVisible())) await page.locator('#fluent-read-video-subtitle-button').click();
  await checked(menu.locator('[data-mode="bilingual"]'), true);
  await screenshot('controls-restored');
  await menu.press('Escape');
  assert.equal(await menu.isVisible(), false);
  report.checks.push('控制栏重挂载保留菜单节点与状态，Esc 正常关闭');
  await page.locator('#fluent-read-video-subtitle-button').click();
  const optionsCreated = context.waitForEvent('page');
  await action('open-settings').click();
  const options = await optionsCreated;
  await options.waitForURL(/options.html/);
  report.checks.push('设置入口打开视频设置');
  await options.close();
  for (const [name, width, height, layout] of [['phone-landscape', 390, 220, 'stack'], ['portrait', 300, 530, 'stack'], ['desktop', 960, 540, 'stack']]) {
    await page.locator('[data-testid="videoPlayer"]').evaluate((player, size) => {
      player.style.width = `${size.width}px`;
      player.style.height = `${size.height}px`;
    }, {width, height});
    if (!(await menu.isVisible())) await page.locator('#fluent-read-video-subtitle-button').click();
    await page.waitForFunction(expected => document.querySelector('#fluent-read-video-subtitle-menu')?.dataset.layout === expected, layout);
    const geometry = await page.evaluate(() => {
      const player = document.querySelector('[data-testid="videoPlayer"]').getBoundingClientRect();
      const menu = document.querySelector('#fluent-read-video-subtitle-menu');
      const rect = menu.getBoundingClientRect();
      return {player: {top: player.top, left: player.left, right: player.right, bottom: player.bottom},
        menu: {top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height},
        scrolls: menu.scrollHeight > menu.clientHeight + 1, overflowX: menu.scrollWidth > menu.clientWidth + 1};
    });
    assert.ok(geometry.menu.top >= geometry.player.top && geometry.menu.left >= geometry.player.left
      && geometry.menu.right <= geometry.player.right && geometry.menu.bottom <= geometry.player.bottom, JSON.stringify(geometry));
    assert.equal(geometry.scrolls, false, JSON.stringify(geometry));
    assert.equal(geometry.overflowX, false, JSON.stringify(geometry));
    (report.menuLayouts ||= []).push({name, layout, ...geometry});
    await page.locator('[data-testid="videoPlayer"]').screenshot({path: path.join(artifacts, `menu-${name}.png`)});
  }
  report.checks.push('观看首页在390×220、竖屏和桌面保持280px紧凑单列，不滚动、不越出播放器');
  // 识别结果已是目标语言（繁体中文 → 简体中文目标）时不请求翻译，双语只显示原文一行。
  const chineseCue = '所以成進去的相機 然後基本上 這個東西';
  assert.equal((await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadClearVideoAiSubtitleCache'}))).success, true);
  assert.equal((await control.evaluate(text => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
    source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'auto', cues: [{startMs: 0, durationMs: 10000, text}]}), chineseCue)).cached, true);
  if (!(await menu.isVisible())) await page.locator('#fluent-read-video-subtitle-button').click();
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), false);
  await page.evaluate(() => { const video = document.querySelector('video'); video.pause(); video.currentTime = 2; });
  const callsBeforeChinese = await worker.evaluate(() => globalThis.fixtureTranslationCalls);
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), true);
  await page.waitForFunction(text => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === text, chineseCue);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.querySelector('#fluent-read-video-subtitle')?.textContent || ''), '');
  await menu.locator('[data-mode="translation-only"]').click();
  await page.waitForFunction(text => document.querySelector('#fluent-read-video-subtitle')?.textContent === text, chineseCue);
  await page.locator('[data-testid="videoPlayer"]').screenshot({path: path.join(artifacts, 'same-language-translation-only.png')});
  await menu.locator('[data-mode="bilingual"]').click();
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle')?.textContent);
  await page.locator('[data-testid="videoPlayer"]').screenshot({path: path.join(artifacts, 'same-language-bilingual.png')});
  assert.equal(await worker.evaluate(() => globalThis.fixtureTranslationCalls), callsBeforeChinese);
  report.checks.push('识别结果已是目标语言时不请求翻译：双语只显示原文一行，仅译文模式仍显示该句');
  // A long cached timeline must be usable independently of translation service availability.
  await clickAction('toggle-ai-subtitle');
  await checked(action('toggle-ai-subtitle'), false);
  const seededLong = await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
    source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'auto',
    cues: Array.from({length: 200}, (_, i) => ({startMs: i * 5000, durationMs: 4800, text: `This is subtitle number ${i + 1}.`}))}));
  assert.equal(seededLong.cached, true);
  await worker.evaluate(() => { globalThis.fixtureTranslationFails = true; globalThis.fixtureTranslationCalls = 0; });
  await clickAction('toggle-ai-subtitle');
  await page.waitForFunction(() => document.querySelector('[data-action="toggle-ai-subtitle"]')?.dataset.ready === 'true');
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'This is subtitle number 1.');
  await action('retry-subtitle-translation').waitFor({state: 'visible'});
  assert.match(await menu.locator('[data-source-status]').innerText(), /200/);
  assert.ok(await worker.evaluate(() => globalThis.fixtureTranslationCalls) <= 8, 'Only nearby captions are prefetched');
  await screenshot('translation-failed');
  await checkCompactState('translation-failed');
  await worker.evaluate(() => { globalThis.fixtureTranslationFails = false; });
  await action('retry-subtitle-translation').click();
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent === '字幕菜单同步测试');
  await action('retry-subtitle-translation').waitFor({state: 'hidden'});
  report.checks.push('200 句缓存无需全片翻译即可就绪；服务空响应保留原文与时间轴，单独重试后恢复译文');

  // Keyboard controls must not trigger the player's key handlers.
  await page.evaluate(() => { window.fixtureHostKeys = 0; document.querySelector('[data-testid="videoPlayer"]').addEventListener('keydown', () => window.fixtureHostKeys++); });
  await menu.locator('[data-mode="bilingual"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await menu.locator('[data-mode="translation-only"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.fixtureHostKeys), 0);
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.locator('#fluent-read-video-subtitle-button').evaluate(node => node === document.activeElement), true);
  await page.locator('#fluent-read-video-subtitle-button').click();
  await action('close-menu').click();
  assert.equal(await menu.isVisible(), false);
  await page.locator('#fluent-read-video-subtitle-button').click();
  report.checks.push('方向键移动选项焦点、不触发播放器快进；Esc 和关闭按钮返回入口焦点');

  // Native captions arriving after cache restoration should replace the automatic cache.
  await page.evaluate(() => {
    const track = document.querySelector('video').addTextTrack('captions', 'English', 'en');
    track.addCue(new VTTCue(0, 4, 'Native captions arrived.'));
    track.addCue(new VTTCue(6, 10, 'Native second caption.'));
    track.mode = 'showing';
  });
  await page.waitForFunction(() => document.querySelector('[data-source-status]')?.textContent === '已加载字幕 · 2 条');
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'Native captions arrived.');
  await page.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 5) < .01 && !document.querySelector('video').seeking);
  await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-original')?.textContent);
  await screenshot('native-source');
  report.checks.push('迟到的原生字幕优先于自动恢复的 AI 缓存；原生静音空档不混入旧 AI 字幕');

  // Original-only must load and display sidecar captions without making translation calls.
  await patchConfig({videoSubtitleDisplayMode: 'original-only'});
  await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadClearVideoAiSubtitleCache'}));
  await page.reload();
  await page.locator('#fluent-read-video-subtitle-button').click();
  await page.waitForFunction(() => document.querySelector('[data-source-status]')?.textContent === '暂未检测到字幕');
  assert.equal(await action('download-subtitles').isDisabled(), true);
  await screenshot('no-subtitles');
  await checkCompactState('no-subtitles');
  const beforeOriginalOnly = await worker.evaluate(() => globalThis.fixtureTranslationCalls);
  await page.evaluate(() => window.postMessage({source: 'fluent-read', type: 'fluent-read-x-video-subtitle-resource',
    pageHref: location.href, url: 'https://video.twimg.com/ext_tw_video/424242/pu/captions/en.vtt',
    responseText: 'WEBVTT\n\n00:00:00.000 --> 00:00:09.000\nOriginal-only sidecar.\n'}, location.origin));
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'Original-only sidecar.');
  await page.waitForTimeout(500);
  assert.equal(await worker.evaluate(() => globalThis.fixtureTranslationCalls), beforeOriginalOnly);
  assert.equal(await action('download-subtitles').isDisabled(), false);
  report.checks.push('无字幕时解释下一步并禁用空导出；仅原文模式可加载原生 sidecar 且翻译请求为零');
  await patchConfig({videoSubtitleVisible: false});
  assert.equal((await control.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
    source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'auto',
    cues: [{startMs: 0, durationMs: 10000, text: 'Recovered while showing originals.'}]}))).cached, true);
  await page.reload();
  await page.locator('#fluent-read-video-subtitle-button').click();
  await menu.locator('[data-mode="original-only"]').click();
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'Recovered while showing originals.');
  report.checks.push('初始隐藏字幕后选择仅原文可恢复本地字幕缓存，无需切到双语');
  assert.deepEqual(report.errors, []);
  report.success = true;
}
main().catch(async error => {
  report.failure = error.stack;
  console.error(error.stack || error);
  if (page) report.failureState = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {time: video?.currentTime, duration: video?.duration, seeking: video?.seeking,
      tracks: [...(video?.textTracks || [])].map(t => ({mode: t.mode, active: [...(t.activeCues || [])].map(c => ({text: c.text, start: c.startTime, end: c.endTime}))})),
      original: document.querySelector('#fluent-read-video-subtitle-original')?.textContent,
      synthetic: document.querySelector('#fluent-read-video-ai-captions')?.textContent};
  }).catch(() => null);
  if (page) await page.screenshot({path: path.join(artifacts, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  let sessionClosed = false;
  try { if (session) { await session.close(); sessionClosed = true; } }
  catch (error) { report.cleanupError = error.stack || String(error); process.exitCode = 1; }
  if (sessionClosed) {
    try { fs.rmSync(profileDir, {recursive: true, force: true}); }
    catch (error) { report.profileCleanupError = error.stack || String(error); process.exitCode = 1; }
  } else report.retainedProfile = profileDir;
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
