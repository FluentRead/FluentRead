#!/usr/bin/env node

const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const {waitForAsyncCondition} = require('./testing/wait-for-async-condition.cjs');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const {spawnSync} = require('node:child_process');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

// 菜单入口的启用样式与菜单展开语义分别取证；aria-pressed 只属于真正的 toggle。
async function readPlayerMenuButtonState(page) {
  return page.evaluate(() => {
    const button = document.querySelector('#fluent-read-video-subtitle-button');
    const menu = document.querySelector('#fluent-read-video-subtitle-menu');
    return {
      present: Boolean(button), role: button?.getAttribute('role') ?? null,
      hasPopup: button?.getAttribute('aria-haspopup') ?? null,
      controls: button?.getAttribute('aria-controls') ?? null,
      expanded: button?.getAttribute('aria-expanded') ?? null,
      pressed: button?.getAttribute('aria-pressed') ?? null,
      active: Boolean(button?.classList.contains('fluent-read-video-subtitle-active')),
      menuPresent: Boolean(menu), menuHidden: menu ? menu.hidden : null,
      offSelected: menu?.querySelector('[data-mode="off"]')?.getAttribute('aria-checked') === 'true',
    };
  });
}
function assertPlayerMenuButtonState(state, expanded) {
  if (!state.present || !state.menuPresent || state.role !== 'button' || state.hasPopup !== 'menu'
    || state.controls !== 'fluent-read-video-subtitle-menu' || state.pressed !== null
    || !['true', 'false'].includes(state.expanded) || state.expanded !== String(!state.menuHidden)
    || (expanded !== undefined && state.expanded !== String(expanded))) {
    throw new Error(`播放器入口不符合菜单按钮契约：${JSON.stringify(state)}`);
  }
}

function loadPlaywright(root) {
  try {
    return require('playwright');
  } catch {
    const runtimeRequire = createRequire(path.join(path.resolve(root), '__fluentread_video_fixture_test__.cjs'));
    return runtimeRequire('playwright');
  }
}

function loadFocusSafeBrowser(helperPath) {
  if (!helperPath) throw new Error('必须传入 --focus-safe-helper，确保真实浏览器在后台隔离运行');
  const resolved = path.resolve(helperPath);
  if (!fs.existsSync(resolved)) throw new Error(`找不到后台浏览器辅助脚本：${resolved}`);
  const helper = require(resolved);
  if (typeof helper.launchFocusSafePersistentContext !== 'function'
    || typeof helper.newPageWithoutForeground !== 'function'
    || typeof helper.activateExtensionTabWithoutForeground !== 'function') {
    throw new Error('后台浏览器辅助脚本缺少所需接口');
  }
  return helper;
}

function assertDedicatedTemporaryProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relativeToTemp = path.relative(temporaryRoot, resolved);
  if (relativeToTemp.startsWith('..') || path.isAbsolute(relativeToTemp)) {
    throw new Error(`profile 不在系统临时目录：${resolved}`);
  }

  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
  ];
  if (forbidden.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) {
    throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
  }
}

const fixtureConfigClientId = `video-subtitle-fixture-${process.pid}-${Date.now()}`;
let fixtureConfigSequence = 0;

async function readExtensionConfig(extensionPage) {
  return extensionPage.evaluate(async () => {
    const parseRecord = (value) => {
      if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    };
    const readRecord = async (key) => {
      const response = await chrome.runtime.sendMessage({ type: 'configStorageRead', key });
      if (response?.success !== true) {
        throw new Error(response?.error || `后台配置读取失败：${key}`);
      }
      return response.value ?? null;
    };

    const publicConfig = parseRecord(await readRecord('local:config'));
    const localCredentials = await readRecord('local:credentials');
    const sessionCredentials = localCredentials === null
      ? await readRecord('session:credentials')
      : null;
    const { schemaVersion: _schemaVersion, ...credentials } = parseRecord(
      localCredentials ?? sessionCredentials,
    );
    return { ...publicConfig, ...credentials };
  });
}

async function persistExtensionConfig(extensionPage, patch) {
  const sequence = ++fixtureConfigSequence;
  const current = await readExtensionConfig(extensionPage);
  const response = await extensionPage.evaluate(async ({ clientId, currentConfig, configPatch, requestSequence }) => {
    const next = {
      ...currentConfig,
      ...configPatch,
      token: { ...(currentConfig.token || {}), ...(configPatch.token || {}) },
      model: { ...(currentConfig.model || {}), ...(configPatch.model || {}) },
    };
    return chrome.runtime.sendMessage({
      type: 'persistConfig',
      config: next,
      clientId,
      sequence: requestSequence,
      ...(Number.isSafeInteger(currentConfig.__fluentConfigRevision)
        ? { baseRevision: currentConfig.__fluentConfigRevision }
        : {}),
    });
  }, {
    clientId: fixtureConfigClientId,
    currentConfig: current,
    configPatch: patch,
    requestSequence: sequence,
  });
  if (!response?.success) {
    throw new Error(`字幕夹具配置保存失败：${JSON.stringify(response)}`);
  }
}

async function readVideoSettingsState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('#settings-video');
    const card = section?.querySelector('.feature-enable-card');
    const toggle = card?.querySelector('[role="switch"]');
    const group = section?.querySelector('[role="radiogroup"][aria-label="视频字幕显示模式"]');
    return {
      checked: toggle?.getAttribute('aria-checked') ?? null,
      disabled: toggle ? toggle.disabled : null,
      summary: card?.querySelector('.feature-enable-description')?.textContent?.trim() || '',
      betaMarkers: [...(card?.querySelectorAll('*') || [])]
        .filter((node) => /beta|测试版/iu.test(node.textContent || '')).length,
      modes: [...(group?.querySelectorAll('[role="radio"]') || [])].map((node) => ({
        label: node.textContent?.trim() || '',
        checked: node.getAttribute('aria-checked'),
        disabled: node.disabled,
      })),
    };
  });
}

async function waitForVideoDisplayModePersistence(page, expectedMode) {
  // 控件先乐观更新；等待后台实际保存，随后仍完整核对 UI 和持久配置。
  await waitForAsyncCondition(async () => (await readExtensionConfig(page)).videoSubtitleDisplayMode === expectedMode,
    {timeoutMs: 5000, message: `字幕模式未持久化为 ${expectedMode}`});
}

function assertEnabledVideoSettingsState(state, stored, expectedMode = 'bilingual') {
  const modeIndex = ['bilingual', 'translation-only', 'original-only'].indexOf(expectedMode);
  const modeLabels = ['双语', '仅译文', '仅原文'];
  if (modeIndex < 0 || state.checked !== 'true' || state.disabled !== false
    || !state.summary || state.betaMarkers !== 0
    || stored.videoTranslationEnabled !== true || stored.videoSubtitleVisible !== true
    || stored.videoSubtitleDisplayMode !== expectedMode
    || state.modes.length !== modeLabels.length
    || state.modes.some((mode, index) => mode.label !== modeLabels[index]
      || mode.checked !== String(index === modeIndex) || mode.disabled !== false)) {
    throw new Error(`视频字幕设置与持久配置不一致：${JSON.stringify({state, stored: {
      videoTranslationEnabled: stored.videoTranslationEnabled,
      videoSubtitleVisible: stored.videoSubtitleVisible,
      videoSubtitleDisplayMode: stored.videoSubtitleDisplayMode,
    }, expectedMode})}`);
  }
}

function comparableConfigWithoutVideoToggle(value) {
  const comparable = {...value};
  delete comparable.videoTranslationEnabled;
  delete comparable.__fluentConfigRevision;
  return JSON.stringify(comparable);
}

async function sampleStableVideoToggleState(page, control, expected, durationMs = 6000) {
  // 界面先乐观更新，后台持久化随后完成；稳定窗口从存储值落定后开始计时。
  const persistDeadline = Date.now() + 5000;
  while ((await readExtensionConfig(control)).videoTranslationEnabled !== expected) {
    if (Date.now() > persistDeadline) throw new Error(`字幕翻译开关没有在 5 秒内持久化为 ${expected}`);
    await page.waitForTimeout(100);
  }
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    const menuButton = await readPlayerMenuButtonState(page);
    if (expected) assertPlayerMenuButtonState(menuButton);
    else if (menuButton.present || menuButton.menuPresent) {
      throw new Error(`关闭视频后播放器入口或菜单仍存在：${JSON.stringify(menuButton)}`);
    }
    const ui = {button: String(menuButton.active), menu: String(menuButton.menuPresent && !menuButton.offSelected), menuButton};
    const stored = await readExtensionConfig(control);
    samples.push({
      elapsedMs: Date.now() - startedAt,
      ...ui,
      stored: stored.videoTranslationEnabled,
      revision: stored.__fluentConfigRevision,
    });
    await page.waitForTimeout(250);
  }

  const expectedString = String(expected);
  if (samples.some((sample) => sample.button !== expectedString
    || sample.menu !== expectedString
    || sample.stored !== expected)) {
    throw new Error(`字幕翻译开关在稳定窗口内发生跳变：${JSON.stringify(samples)}`);
  }
  if (new Set(samples.map((sample) => sample.revision)).size !== 1) {
    throw new Error(`字幕翻译开关稳定后仍在重复写配置：${JSON.stringify(samples)}`);
  }
  return samples;
}

const OFFLINE_YOUTUBE_FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>YouTube subtitle fixture</title><script>var ytInitialPlayerResponse={"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en&kind=download","languageCode":"en","name":{"simpleText":"English"}}]}}};</script></head>
<body><main><div id="movie_player" class="html5-video-player"></div></main></body></html>`;


async function main() {
  const suite = arg('suite', 'full');
  if (!['full', 'menu'].includes(suite)) throw new Error(`未知视频 fixture suite：${suite}`);
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const playwrightRoot = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
  const url = arg('url', 'https://www.youtube.com/watch?v=fluentread-offline-fixture');
  const artifactsDir = path.resolve(arg('artifacts-dir', path.join(os.tmpdir(), 'fluentread-video-subtitle-fixture')));
  const browserPath = arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  const focusSafeHelper = arg('focus-safe-helper', process.env.FLUENTREAD_FOCUS_SAFE_HELPER || path.join(__dirname, 'testing/focus-safe-browser.cjs'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-edge-video-fixture-'));
  let browserSession, providerFixtureServer, evidence; let launchAttempted = false; let primaryError;
  try {
  assertDedicatedTemporaryProfile(profileDir);
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`找不到扩展构建：${extensionDir}`);
  fs.mkdirSync(artifactsDir, { recursive: true });
  // 预取窗口覆盖到 20 秒，媒体本身必须足够长，才能用真实 currentTime 验证显示时间。
  const mediaFile = path.join(artifactsDir, 'fixture.mp4');
  const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1',
    '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], {encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL'});
  if (media.status !== 0) throw new Error(`无法生成视频时间轴夹具：${media.stderr}`);
  const videoFixtureDataUrl = `data:video/mp4;base64,${fs.readFileSync(mediaFile).toString('base64')}`;

  const { chromium } = loadPlaywright(playwrightRoot);
  const {
    activateExtensionTabWithoutForeground,
    launchFocusSafePersistentContext,
    newPageWithoutForeground,
  } = loadFocusSafeBrowser(focusSafeHelper);
  launchAttempted = true;
  browserSession = await launchFocusSafePersistentContext({
    chromium,
    profileDir,
    browserPath,
    headless: false,
    background: true,
    displayTarget: 'secondary',
    browserArgs: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 900 },
  });
  guardBrowserClose(browserSession, profileDir);
  const context = browserSession.context;
  const createPage = () => newPageWithoutForeground(context);
  const activatePage = (page) => activateExtensionTabWithoutForeground(context, page);

  let translationRequests = 0;
  const translationSources = [];
  const aiTranslationSources = [];
  const navigationMode = 'offline-youtube-fixture';
  const unexpectedNetworkRequests = [];
  const consoleErrors = [];
  const fixtureTranslations = {
    'and the housing market took a hit.': '房地产市场受到了冲击。',
    'Download translated subtitle.': '可下载的译文字幕。',
    'Offline viewing stays in sync.': '离线观看仍与时间轴同步。',
    'understand from [music] the axioms and the basics.': '从音乐中理解公理和基础。',
    'Timeline subtitle catches up.': '时间轴已追上字幕。',
    'This subtitle was translated in advance.': '预先翻译的字幕。',
  };
  providerFixtureServer = http.createServer(async (request, response) => {
    const responseHeaders = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...responseHeaders,
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      });
      response.end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }

    if (request.method === 'POST' && request.url === '/microsoft') {
      translationRequests += 1;
      const source = Array.isArray(body) ? String(body[0] || '') : '';
      translationSources.push(source);
      if (source === 'Download translated subtitle.' || source === 'Offline viewing stays in sync.') {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      response.writeHead(200, responseHeaders);
      response.end(JSON.stringify([{ translations: [{ text: fixtureTranslations[source] || `【译文】${source}` }] }]));
      return;
    }

    if (request.method === 'POST' && request.url === '/openai') {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const source = [...messages].reverse().find(message => message?.role === 'user')?.content || '';
      aiTranslationSources.push(String(source));
      response.writeHead(200, responseHeaders);
      response.end(JSON.stringify({ choices: [{ message: { content: 'AI预先翻译的字幕。' } }] }));
      return;
    }

    if (request.method === 'POST' && request.url === '/unexpected') {
      const attemptedUrl = typeof body?.url === 'string' ? body.url : 'unknown-worker-request';
      unexpectedNetworkRequests.push(attemptedUrl);
      response.writeHead(502, responseHeaders);
      response.end(JSON.stringify({ error: '视频字幕 fixture 已阻止未授权外网请求' }));
      return;
    }

    response.writeHead(404, responseHeaders);
    response.end(JSON.stringify({ error: 'unknown fixture route' }));
  });

    await new Promise((resolve, reject) => {
      providerFixtureServer.once('error', reject);
      providerFixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const providerFixtureAddress = providerFixtureServer.address();
    if (!providerFixtureAddress || typeof providerFixtureAddress === 'string') {
      throw new Error('无法取得 provider fixture 的 loopback 地址');
    }
    const providerFixtureOrigin = `http://127.0.0.1:${providerFixtureAddress.port}`;

    // Playwright 的 route 不能可靠覆盖 MV3 Service Worker 内的 fetch。页面路由只负责
    // YouTube fixture 与 fail-closed，provider 请求由下方 worker fetch 包装器重定向。
    await context.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (requestUrl.origin === providerFixtureOrigin) {
        await route.continue();
        return;
      }
      if (requestUrl.hostname === 'www.youtube.com' && requestUrl.pathname === '/api/timedtext') {
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({events: []})});
        return;
      }
      const isNetworkRequest = requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:';
      if (isNetworkRequest) {
        unexpectedNetworkRequests.push(request.url());
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) throw new Error(`无法取得扩展 ID：${worker.url()}`);
    const attachWorkerDiagnostics = (target) => {
      target.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`worker console: ${message.text()}`);
      });
    };
    const installProviderFixtures = (target) => target.evaluate((fixtureOrigin) => {
      if (globalThis.__fluentReadVideoProviderFixtureInstalled) return;
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const fixtureFetch = (pathname, init) => nativeFetch(`${fixtureOrigin}${pathname}`, init);
      globalThis.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
        let parsedUrl;
        try {
          parsedUrl = new URL(requestUrl);
        } catch {
          return nativeFetch(input, init);
        }
        if (parsedUrl.hostname === 'edge.microsoft.com' && parsedUrl.pathname === '/translate/translatetext') {
          return fixtureFetch('/microsoft', init);
        }
        if (parsedUrl.hostname === 'api.openai.com' && parsedUrl.pathname === '/v1/chat/completions') {
          return fixtureFetch('/openai', init);
        }
        if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
          return fixtureFetch('/unexpected', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({url: requestUrl}),
            signal: init?.signal,
          });
        }
        return nativeFetch(input, init);
      };
      globalThis.__fluentReadVideoProviderFixtureInstalled = true;
    }, providerFixtureOrigin);
    attachWorkerDiagnostics(worker);
    await installProviderFixtures(worker);
    context.on('serviceworker', (target) => {
      attachWorkerDiagnostics(target);
      void installProviderFixtures(target).catch((error) => {
        consoleErrors.push(`worker fixture install: ${error.message}`);
      });
    });

    const control = await createPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await activatePage(control);
    await control.waitForTimeout(500);
    await control.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout: 10000});
    let initialVideoSettingsState, crossContextDocumentConfig, popupFeature;
    let videoSettingsDescription, videoSettingsDisplayModes, videoSettingsDisplayModePersisted;
    if (suite === 'full') {
    // 新 main 将视频总开关与显示模式集中到设置页；Popup 卡片已移除。
    // 首次配置的真实默认值仍为开启/可见/双语，同时核对 UI 与后台持久记录。
    const videoSettingsPage = await createPage();
    await videoSettingsPage.goto(`chrome-extension://${extensionId}/options.html#settings-video`, {waitUntil: 'domcontentloaded'});
    await activatePage(videoSettingsPage);
    const videoSettings = videoSettingsPage.locator('#settings-video');
    await videoSettings.getByRole('switch', {name: '视频字幕翻译', exact: true}).waitFor({state: 'visible', timeout: 10000});
    const videoDisplayModes = videoSettings.getByRole('radiogroup', {name: '视频字幕显示模式', exact: true});
    await videoDisplayModes.waitFor({state: 'visible', timeout: 10000});
    initialVideoSettingsState = await readVideoSettingsState(videoSettingsPage);
    assertEnabledVideoSettingsState(initialVideoSettingsState, await readExtensionConfig(control));
    await persistExtensionConfig(control, {uiLanguageSetupCompleted: true, videoTranslationEnabled: false});
    await control.reload({waitUntil: 'domcontentloaded'});
    await control.locator('.popup-shell').waitFor({state: 'visible', timeout: 10000});
    await control.waitForFunction(
      () => !document.querySelector('[data-testid="ui-language-onboarding"]'),
      null,
      {timeout: 10000},
    );

    // 文档页过去只在启动时复制一次整份配置；它保持打开时，随后保存任一文档
    // 选项会把旧的字幕开关连同最新 revision 一起回灌。先以关闭状态打开文档页，
    // 再从其他上下文开启字幕，验证字段级保存不会覆盖刚更新的全局字段。
    const documentConfigPage = await createPage();
    await documentConfigPage.goto(`chrome-extension://${extensionId}/document.html`, { waitUntil: 'domcontentloaded' });
    await activatePage(documentConfigPage);
    await documentConfigPage.locator('input[type="file"]').setInputFiles({
      name: 'stale-config-probe.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('FluentRead cross-context configuration probe.', 'utf8'),
    });
    await documentConfigPage.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
    const documentSettings = documentConfigPage.getByRole('dialog', {name: '翻译设置', exact: true});
    await documentSettings.waitFor({state: 'visible', timeout: 15000});
    const documentSourceLanguage = documentSettings.getByRole('combobox', { name: '文档源语言', exact: true });
    await documentSourceLanguage.waitFor({state: 'visible', timeout: 15000});
    await persistExtensionConfig(control, {
      on: true,
      from: 'auto',
      to: 'zh-Hans',
      videoTranslationEnabled: true,
      videoService: 'microsoft',
      videoServiceDefaultMigrated: true,
      videoSubtitleVisible: true,
      videoSubtitleDisplayMode: 'bilingual',
      useCache: false,
    });
    await documentSourceLanguage.click({ force: true });
    const englishOption = documentConfigPage.locator('[role="option"]:visible').filter({ hasText: 'English' }).first();
    await englishOption.waitFor({ state: 'visible', timeout: 10000 });
    await englishOption.evaluate((element) => element.click());
    await waitForAsyncCondition(() => documentConfigPage.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (response?.success !== true) throw new Error(response?.error || '后台配置读取失败：local:config');
      const current = typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
      return current?.from === 'en' && current.videoTranslationEnabled === true;
    }), {timeoutMs: 10000, message: '文档源语言与字幕开关未持久化'});
    crossContextDocumentConfig = await readExtensionConfig(control);
    if (crossContextDocumentConfig.from !== 'en' || crossContextDocumentConfig.videoTranslationEnabled !== true) {
      throw new Error(`文档页旧快照覆盖了字幕开关：${JSON.stringify(crossContextDocumentConfig)}`);
    }
    await documentConfigPage.close();
    // Popup 当前的视频入口是翻译服务分配行，字幕控制在设置页和播放器内。
    await activatePage(control);
    await control.locator('[data-testid="popup-feature-services"]').click();
    const popupServices = control.locator('.popup-service-panel');
    const popupVideoService = popupServices.locator('[data-feature-service="video"]');
    await popupVideoService.waitFor({state: 'visible', timeout: 10000});
    popupFeature = await popupVideoService.evaluate((row) => ({
      entryPresent: row.getAttribute('data-feature-service') === 'video',
      summary: row.querySelector('.assignment-value')?.textContent?.trim() || '',
      betaMarkers: [...row.querySelectorAll('*')]
        .filter((node) => /beta|测试版/iu.test(node.textContent || '')).length,
    }));
    if (!popupFeature.entryPresent || !popupFeature.summary || popupFeature.betaMarkers !== 0) {
      throw new Error(`Popup 视频服务入口校验失败：${JSON.stringify(popupFeature)}`);
    }
    await control.screenshot({path: path.join(artifactsDir, 'popup-video-service.png'), fullPage: true});
    await popupServices.locator('.service-panel-close').click();

    await activatePage(videoSettingsPage);
    await videoSettingsPage.waitForFunction(() => document.querySelector('#settings-video .feature-enable-card [role="switch"]')?.getAttribute('aria-checked') === 'true', null, {timeout: 10000});
    const videoSettingsState = await readVideoSettingsState(videoSettingsPage);
    assertEnabledVideoSettingsState(videoSettingsState, await readExtensionConfig(control));
    videoSettingsDescription = videoSettingsState.summary;
    videoSettingsDisplayModes = videoSettingsState.modes.map((mode) => mode.label);
    await videoDisplayModes.getByRole('radio', {name: '仅译文', exact: true}).click();
    await waitForVideoDisplayModePersistence(control, 'translation-only');
    const videoDisplayModeConfig = await readExtensionConfig(control);
    videoSettingsDisplayModePersisted = videoDisplayModeConfig.videoSubtitleDisplayMode;
    assertEnabledVideoSettingsState(await readVideoSettingsState(videoSettingsPage), videoDisplayModeConfig, 'translation-only');
    await videoDisplayModes.getByRole('radio', {name: '双语', exact: true}).click();
    await waitForVideoDisplayModePersistence(control, 'bilingual');
    assertEnabledVideoSettingsState(await readVideoSettingsState(videoSettingsPage), await readExtensionConfig(control));
    // 后续清晰度断言依赖 140% 字号，继续通过原持久化接口写入。
    const videoAppearance = (await readExtensionConfig(control)).videoSubtitleAppearance || {};
    await persistExtensionConfig(control, {videoSubtitleAppearance: {...videoAppearance, fontScale: 140}});
    await videoSettingsPage.screenshot({path: path.join(artifactsDir, 'video-subtitle-settings.png'), fullPage: true});
    // 结束设置页会话，避免其草稿在播放器真实动作阶段参与保存。
    await videoSettingsPage.close();

    } else {
      // 菜单专项仅配置隔离 profile 的前置；关闭后通过真实 Options 总开关重新启用。
      await persistExtensionConfig(control, {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true,
        from: 'auto', to: 'zh-Hans', videoTranslationEnabled: true, videoService: 'microsoft',
        videoServiceDefaultMigrated: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', useCache: false});
    }

    const page = await createPage();
    const pageErrors = [];
    const collectPageError = (error) => pageErrors.push(error.stack || error.message);
    page.on('pageerror', collectPageError);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.route(url, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: OFFLINE_YOUTUBE_FIXTURE_HTML,
    }), { times: 1 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await activatePage(page);
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const description = document.querySelector('meta[name="description"]') || document.createElement('meta');
      description.setAttribute('name', 'description');
      description.setAttribute('content', 'FluentRead fixture context: this video explains orbital habitat economics and launch terminology.');
      if (!description.isConnected) document.head.append(description);
    });

    await page.evaluate((videoDataUrl) => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (!(player instanceof HTMLElement)) throw new Error('找不到 YouTube 播放器容器');

      player.style.cssText += [
        'display:block !important',
        'visibility:visible !important',
        'opacity:1 !important',
        'position:fixed !important',
        'left:24px !important',
        'top:24px !important',
        'width:960px !important',
        'height:540px !important',
        'z-index:2147483000 !important',
        'background:#111 !important',
        'overflow:hidden !important',
      ].join(';');
      player.replaceChildren();

      const surface = document.createElement('div');
      surface.style.cssText = 'position:absolute;inset:0;background:linear-gradient(135deg,#111827,#020617);';
      const label = document.createElement('div');
      label.textContent = 'FluentRead 视频字幕翻译 Fixture';
      label.style.cssText = 'position:absolute;left:28px;top:24px;color:#94a3b8;font:600 18px/1.4 Arial,sans-serif;';
      surface.appendChild(label);

      const video = document.createElement('video');
      video.className = 'html5-main-video';
      video.muted = true;
      video.preload = 'auto';
      video.src = videoDataUrl;
      video.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      video.load();

      const container = document.createElement('div');
      container.id = 'ytp-caption-window-container';
      container.style.cssText = 'position:absolute;left:0;right:0;top:66%;height:18%;z-index:4;text-align:center;color:#fff;font:600 30px/1.35 Arial,sans-serif;';
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = '';
      container.appendChild(segment);

      const controls = document.createElement('div');
      controls.className = 'ytp-right-controls';
      controls.style.cssText = 'position:absolute;right:20px;bottom:18px;display:flex;align-items:center;gap:8px;width:auto;height:52px;z-index:8;';
      const existingTranslationButton = document.createElement('button');
      existingTranslationButton.type = 'button';
      existingTranslationButton.className = 'fixture-existing-translation-button';
      existingTranslationButton.textContent = '其他翻译';
      existingTranslationButton.style.cssText = 'width:64px;height:40px;color:#fff;background:#334155;border:0;border-radius:8px;font-size:12px;';
      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'ytp-settings-button';
      settings.textContent = '⚙';
      settings.style.cssText = 'width:40px;height:40px;color:#fff;background:#334155;border:0;border-radius:8px;font-size:20px;';
      controls.append(existingTranslationButton, settings);

      player.append(surface, video, container, controls);
    }, videoFixtureDataUrl);

    await page.waitForFunction(() => {
      const video = document.querySelector('video.html5-main-video');
      return Boolean(video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration >= 5);
    }, null, { timeout: 15000 });

    await page.waitForFunction(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-button');
      return Boolean(button?.closest('.ytp-right-controls'));
    }, null, { timeout: 15000 });

    const playerUi = await page.evaluate(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-button');
      const icon = document.querySelector('#fluent-read-video-subtitle-button .fluent-read-video-subtitle-button-icon');
      const buttonRect = button?.getBoundingClientRect();
      const iconRect = icon?.getBoundingClientRect();
      return {
        buttonPresent: Boolean(button),
        buttonInControls: Boolean(button?.closest('.ytp-right-controls')),
        buttonEnabled: Boolean(button?.classList.contains('fluent-read-video-subtitle-active')),
        buttonRect: buttonRect?.toJSON() || null,
        iconRect: iconRect?.toJSON() || null,
        iconTag: icon?.tagName || '',
        iconSrc: icon instanceof HTMLImageElement ? icon.src : '',
        // 入口追加在原生右侧控制栏末尾，与 X 播放器保持同一位置语义。
        buttonIsLastControl: button?.parentElement?.lastElementChild === button,
        iconCenterDelta: buttonRect && iconRect
          ? Math.abs((buttonRect.top + buttonRect.height / 2) - (iconRect.top + iconRect.height / 2))
          : null,
      };
    });
    if (!playerUi.buttonPresent || !playerUi.buttonInControls || !playerUi.buttonIsLastControl || playerUi.iconTag !== 'IMG' || !playerUi.iconSrc.includes('/icon/128.png') || playerUi.iconCenterDelta === null || playerUi.iconCenterDelta > 2) {
      throw new Error(`播放器入口布局校验失败：${JSON.stringify(playerUi)}`);
    }

    const initialMenuButton = await readPlayerMenuButtonState(page);
    assertPlayerMenuButtonState(initialMenuButton, false);
    await page.locator('#fluent-read-video-subtitle-button').press('Enter');
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === false, null, { timeout: 10000 });
    const menu = await page.evaluate(() => ({
      brand: document.querySelector('#fluent-read-video-subtitle-menu .fluent-read-video-menu-brand')?.textContent || '',
      betaMarkers: [...document.querySelectorAll('#fluent-read-video-subtitle-menu *')]
        .filter((node) => /beta|测试版/iu.test(node.textContent || '')).length,
      service: document.querySelector('#fluent-read-video-subtitle-menu [data-service-label]')?.textContent || '',
      bilingual: document.querySelector('#fluent-read-video-subtitle-menu [data-mode="bilingual"]')?.getAttribute('aria-checked') === 'true',
      offChecked: document.querySelector('#fluent-read-video-subtitle-menu [data-mode="off"]')?.getAttribute('aria-checked') || '',
      modeLabels: [...document.querySelectorAll('#fluent-read-video-subtitle-menu [data-mode]')].map((node) => node.textContent || ''),
      legacySwitches: document.querySelectorAll('#fluent-read-video-subtitle-menu .fluent-read-video-menu-switch, #fluent-read-video-subtitle-menu [data-action="toggle-translation"], #fluent-read-video-subtitle-menu [data-action="toggle-visible"]').length,
      playerButtonActive: Boolean(document.querySelector('#fluent-read-video-subtitle-button')?.classList.contains('fluent-read-video-subtitle-active')),
      originalDownloadLabel: document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"] .fluent-read-video-menu-label')?.textContent || '',
      translatedDownloadLabel: document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"] .fluent-read-video-menu-label')?.textContent || '',
      originalDownloadName: document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]')?.getAttribute('aria-label') || '',
      translatedDownloadName: document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"]')?.getAttribute('aria-label') || '',
      downloadStatusLive: document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.getAttribute('aria-live') || '',
      downloadStatusAtomic: document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.getAttribute('aria-atomic') || '',
      rect: document.querySelector('#fluent-read-video-subtitle-menu')?.getBoundingClientRect().toJSON() || null,
      viewport: {width: innerWidth, height: innerHeight},
    }));
    if (menu.brand !== '流畅阅读' || menu.betaMarkers !== 0 || menu.service !== '微软翻译' || !menu.bilingual
      || menu.offChecked !== 'false' || !menu.playerButtonActive || menu.legacySwitches !== 0
      || JSON.stringify(menu.modeLabels) !== JSON.stringify(['双语', '译文', '原文', '关闭'])
      || menu.originalDownloadLabel !== '原文' || menu.translatedDownloadLabel !== '译文'
      || menu.originalDownloadName !== '下载原文字幕' || menu.translatedDownloadName !== '下载译文字幕'
      || menu.downloadStatusLive !== 'polite' || menu.downloadStatusAtomic !== 'true'
      || !menu.rect || menu.rect.width <= 0 || menu.rect.height <= 0 || menu.rect.width > 280 || menu.rect.height > 180
      || menu.rect.left < 0 || menu.rect.top < 0 || menu.rect.right > menu.viewport.width || menu.rect.bottom > menu.viewport.height) {
      throw new Error(`播放器菜单校验失败：${JSON.stringify(menu)}`);
    }

    const openedMenuButton = await readPlayerMenuButtonState(page);
    assertPlayerMenuButtonState(openedMenuButton, true);

    await page.evaluate(() => {
      const edges = [];
      let last = '';
      const record = () => {
        const playerButton = document.querySelector('#fluent-read-video-subtitle-button');
        const offChoice = document.querySelector('#fluent-read-video-subtitle-menu [data-mode="off"]');
        const next = JSON.stringify({
          button: String(Boolean(playerButton?.classList.contains('fluent-read-video-subtitle-active'))),
          menu: String(Boolean(offChoice && offChoice.getAttribute('aria-checked') !== 'true')),
        });
        if (next === last) return;
        last = next;
        edges.push(JSON.parse(next));
      };
      record();
      const observer = new MutationObserver(record);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'aria-expanded', 'aria-pressed', 'aria-checked'],
      });
      window.__fluentReadVideoToggleEdges = edges;
      window.__fluentReadVideoToggleObserver = observer;
    });
    const beforeDisableConfig = await readExtensionConfig(control);
    await page.locator('#fluent-read-video-subtitle-menu [data-mode="off"]').press('Enter');
    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-button')
      && !document.querySelector('#fluent-read-video-subtitle-menu')
      && !document.querySelector('#fluent-read-video-subtitle')?.textContent?.trim(), null, {timeout: 10000});
    const disabledMenu = await page.evaluate(() => ({
      buttonPresent: Boolean(document.querySelector('#fluent-read-video-subtitle-button')),
      menuPresent: Boolean(document.querySelector('#fluent-read-video-subtitle-menu')),
      overlayText: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
    }));
    const disabledStabilitySamples = await sampleStableVideoToggleState(page, control, false);
    const afterDisableConfig = await readExtensionConfig(control);
    if (afterDisableConfig.__fluentConfigRevision !== beforeDisableConfig.__fluentConfigRevision + 1
      || comparableConfigWithoutVideoToggle(afterDisableConfig) !== comparableConfigWithoutVideoToggle(beforeDisableConfig)) {
      throw new Error(`关闭字幕翻译产生了额外配置差异：${JSON.stringify({beforeDisableConfig, afterDisableConfig})}`);
    }
    await page.screenshot({path: path.join(artifactsDir, 'video-subtitle-fixture-disabled.png'), fullPage: false});
    // Off 会销毁入口和菜单；只通过真实设置控件恢复，不能点击旧节点或直接写配置。
    const reenableSettingsPage = await createPage();
    let reenabledFromSettings;
    try {
      await reenableSettingsPage.goto(`chrome-extension://${extensionId}/options.html#settings-video`, {waitUntil: 'domcontentloaded'});
      await activatePage(reenableSettingsPage);
      const toggle = reenableSettingsPage.locator('#settings-video').getByRole('switch', {name: '视频字幕翻译', exact: true});
      await toggle.waitFor({state: 'visible', timeout: 10000});
      if (await toggle.getAttribute('aria-checked') !== 'false') throw new Error('设置页未显示视频关闭状态');
      await toggle.press('Enter');
      await reenableSettingsPage.waitForFunction(() => document.querySelector('#settings-video .feature-enable-card [role="switch"]')?.getAttribute('aria-checked') === 'true', null, {timeout: 10000});
      await waitForAsyncCondition(async () => (await readExtensionConfig(control)).videoTranslationEnabled === true,
        {timeoutMs: 10000, message: '从真实设置页重新启用视频未持久化'});
      reenabledFromSettings = await readVideoSettingsState(reenableSettingsPage);
      assertEnabledVideoSettingsState(reenabledFromSettings, await readExtensionConfig(control));
      await reenableSettingsPage.screenshot({path: path.join(artifactsDir, 'video-subtitle-fixture-settings-reenabled.png'), fullPage: true});
    } finally {
      await reenableSettingsPage.close();
    }
    await activatePage(page);
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-button')?.classList.contains('fluent-read-video-subtitle-active') === true
      && document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === true, null, {timeout: 10000});
    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), false);
    await page.locator('#fluent-read-video-subtitle-button').press('Enter');
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === false, null, {timeout: 10000});
    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), true);
    const enabledStabilitySamples = await sampleStableVideoToggleState(page, control, true);
    const afterEnableConfig = await readExtensionConfig(control);
    if (afterEnableConfig.__fluentConfigRevision !== afterDisableConfig.__fluentConfigRevision + 1
      || comparableConfigWithoutVideoToggle(afterEnableConfig) !== comparableConfigWithoutVideoToggle(afterDisableConfig)) {
      throw new Error(`开启字幕翻译产生了额外配置差异：${JSON.stringify({afterDisableConfig, afterEnableConfig})}`);
    }
    const videoToggleEdges = await page.evaluate(() => {
      window.__fluentReadVideoToggleObserver?.disconnect();
      return window.__fluentReadVideoToggleEdges || [];
    });
    const expectedVideoToggleEdges = [
      {button: 'true', menu: 'true'},
      {button: 'false', menu: 'false'},
      {button: 'true', menu: 'true'},
    ];
    if (JSON.stringify(videoToggleEdges) !== JSON.stringify(expectedVideoToggleEdges)) {
      throw new Error(`字幕翻译开关出现了多余状态边沿：${JSON.stringify(videoToggleEdges)}`);
    }
    await page.locator('#fluent-read-video-subtitle-menu').screenshot({ path: path.join(artifactsDir, 'video-subtitle-fixture-menu.png') });

    if (suite === 'menu') {
      const beforeCloseConfig = await readExtensionConfig(control);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === true, null, {timeout: 10000});
      const closedMenuButton = await readPlayerMenuButtonState(page); assertPlayerMenuButtonState(closedMenuButton, false);
      await page.locator('#fluent-read-video-subtitle-button').click();
      await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === false, null, {timeout: 10000});
      const reopenedMenuButton = await readPlayerMenuButtonState(page); assertPlayerMenuButtonState(reopenedMenuButton, true);
      await page.screenshot({path: path.join(artifactsDir, 'video-menu-only-reopened.png'), fullPage: false});
      const entryLabel = await page.locator('#fluent-read-video-subtitle-button').getAttribute('aria-label');
      if (!entryLabel) throw new Error('重开后的播放器菜单入口缺少 aria-label');
      const accessibilitySession = await context.newCDPSession(page);
      let menuAccessibility;
      try {
        await accessibilitySession.send('Accessibility.enable');
        const tree = await accessibilitySession.send('Accessibility.getFullAXTree');
        const nodes = tree.nodes.filter(node => !node.ignored && node.role?.value === 'button' && node.name?.value === entryLabel);
        menuAccessibility = {scope: 'Chromium AX node only; no assistive-technology speech verification', entryLabel, nodes};
        fs.writeFileSync(path.join(artifactsDir, 'video-menu-only-reopened-ax.json'), `${JSON.stringify(menuAccessibility, null, 2)}\n`);
        if (nodes.length !== 1) throw new Error(`播放器菜单入口 AX button 数量不符：${nodes.length}`);
        const properties = Object.fromEntries((nodes[0].properties || []).map(property => [property.name, property.value?.value]));
        if (properties.hasPopup !== 'menu' || properties.expanded !== true || Object.hasOwn(properties, 'pressed')) {
          throw new Error(`播放器菜单入口 AX 语义不符：${JSON.stringify(properties)}`);
        }
      } finally {
        await accessibilitySession.detach();
      }
      await page.locator('#fluent-read-video-subtitle-menu [data-action="close-menu"]').click();
      await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === true, null, {timeout: 10000});
      const finalMenuButton = await readPlayerMenuButtonState(page); assertPlayerMenuButtonState(finalMenuButton, false);
      const afterCloseConfig = await readExtensionConfig(control);
      if (JSON.stringify(afterCloseConfig) !== JSON.stringify(beforeCloseConfig)) throw new Error('仅关闭和重开菜单修改了字幕配置');
      await page.screenshot({path: path.join(artifactsDir, 'video-menu-only-closed.png'), fullPage: false});
      evidence = {ok: pageErrors.length === 0 && consoleErrors.length === 0 && unexpectedNetworkRequests.length === 0
        && translationRequests === 0 && aiTranslationSources.length === 0,
        suite, scope: 'Production menu-button semantics, keyboard Off removes entry/menu, real Options switch re-enables, close/reopen and persistence only',
        notRun: ['full Options/document cross-context matrix', 'subtitle translation/provider quality', 'download', 'timing/pretranslation/karaoke', 'native mobile/assistive technology'],
        navigationMode, playerUi, menu, disabledMenu, reenabledFromSettings, menuAccessibility,
        menuButtons: {initial: initialMenuButton, opened: openedMenuButton, closed: closedMenuButton, reopened: reopenedMenuButton, final: finalMenuButton},
        videoToggleStability: {edges: videoToggleEdges, disabledSamples: disabledStabilitySamples.length, enabledSamples: enabledStabilitySamples.length},
        translationRequests, aiTranslationRequests: aiTranslationSources.length, pageErrors, consoleErrors, unexpectedNetworkRequests,
        launchMode: browserSession.launchMode, focusPolicy: browserSession.focusPolicy, windowPlacement: browserSession.windowPlacement, artifactsDir};
      fs.writeFileSync(path.join(artifactsDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      if (!evidence.ok) throw new Error(`视频菜单专项失败：${JSON.stringify(evidence)}`);
      console.log(JSON.stringify(evidence, null, 2));
      return; // 继续执行原 finally，回收隔离浏览器、profile 与 loopback server。
    }

    const downloadSources = ['Download translated subtitle.', 'Offline viewing stays in sync.'];
    const downloadTimedTextResponse = JSON.stringify({ events: [
      { tStartMs: 120000, dDurationMs: 1600, segs: [{ utf8: downloadSources[0] }] },
      { tStartMs: 122000, dDurationMs: 1800, segs: [{ utf8: downloadSources[1] }] },
    ] });
    let slowTimedTextRequests = 0;
    await page.route('https://www.youtube.com/api/timedtext**', async (route) => {
      slowTimedTextRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 2300));
      await route.fulfill({ status: 200, contentType: 'application/json', body: downloadTimedTextResponse });
    });
    await page.evaluate(() => {
      const source = `var ytInitialPlayerResponse = ${JSON.stringify({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{
              baseUrl: 'https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en&kind=download',
              languageCode: 'en',
              name: { simpleText: 'English' },
            }],
          },
        },
      })};`;
      const script = document.createElement('script');
      const trustedTypesFactory = window.trustedTypes;
      if (trustedTypesFactory) {
        const policy = trustedTypesFactory.createPolicy(`fluentread-fixture-${Date.now()}`, {
          createScript: value => value,
        });
        script.text = policy.createScript(source);
      } else {
        script.text = source;
      }
      document.documentElement.appendChild(script);
      history.replaceState(history.state, '', '/watch?v=fixture-original-slow');
    });
    await page.waitForTimeout(1200);

    let originalDownloadError;
    const originalDownloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch((error) => {
      originalDownloadError = error;
      return null;
    });
    await page.locator('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]').press('Enter');
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]');
        return button?.getAttribute('aria-busy') === 'true'
          && document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent === '正在获取…';
      }, null, { timeout: 10000 });
    } catch (error) {
      const initialFeedbackDebug = await page.evaluate(() => {
        const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]');
        return {
          url: location.href,
          menuHidden: document.querySelector('#fluent-read-video-subtitle-menu')?.hidden,
          state: document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent || '',
          busy: button?.getAttribute('aria-busy') || '',
          disabled: button?.hasAttribute('disabled') || false,
        };
      });
      throw new Error(`没有观察到原文下载初始状态：${JSON.stringify({ initialFeedbackDebug, slowTimedTextRequests, cause: error instanceof Error ? error.message : String(error) })}`);
    }
    const originalDownloadInitialFeedback = await page.evaluate(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]');
      const state = document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]');
      const spinner = button ? getComputedStyle(button, '::before') : null;
      return {
        state: state?.textContent || '',
        busy: button?.getAttribute('aria-busy') || '',
        spinnerContent: spinner?.content || '',
        spinnerWidth: spinner?.width || '',
      };
    });
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent === '仍在读取…', null, { timeout: 5000 });
    const originalDownloadSlowFeedback = await page.evaluate(() => ({
      state: document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent || '',
      busy: document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]')?.getAttribute('aria-busy') || '',
    }));
    const originalDownload = await originalDownloadPromise;
    if (!originalDownload) {
      const downloadDebug = await page.evaluate(() => {
        const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]');
        const translatedButton = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"]');
        return {
          menuHidden: document.querySelector('#fluent-read-video-subtitle-menu')?.hidden,
          originalDisabled: button?.hasAttribute('disabled'),
          originalState: document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent || '',
          translatedPresent: Boolean(translatedButton),
          translatedDisabled: translatedButton?.hasAttribute('disabled'),
          pageUrl: location.href,
          pageTitle: document.title,
        };
      });
      throw new Error(`原文字幕下载事件超时：${JSON.stringify({ downloadDebug, pageErrors, cause: originalDownloadError instanceof Error ? originalDownloadError.message : String(originalDownloadError) })}`);
    }
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent === '已下载 · 2 条', null, { timeout: 10000 });
    const originalDownloadFeedback = await page.evaluate(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]');
      const state = document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]');
      return {
        state: state?.textContent || '',
        busy: button?.getAttribute('aria-busy') || '',
        disabled: button?.hasAttribute('disabled') || false,
      };
    });
    const originalDownloadPath = await originalDownload.path();
    const originalDownloadText = originalDownloadPath ? fs.readFileSync(originalDownloadPath, 'utf8') : '';
    const slowTimedTextRequestsAfterOriginal = slowTimedTextRequests;

    let translatedDownloadError;
    const translatedDownloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch((error) => {
      translatedDownloadError = error;
      return null;
    });
    await page.locator('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"]').press('Enter');
    // 译文导出先在菜单内列出待补译的数量，确认后才开始请求翻译。
    await page.locator('#fluent-read-video-subtitle-menu [data-export-prompt] [data-export-choice="complete"]').click({timeout: 15000});
    await page.waitForFunction(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"]');
      return button?.getAttribute('aria-busy') === 'true'
        && document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent?.startsWith('翻译 ');
    }, null, { timeout: 10000 });
    const translatedDownloadBusyFeedback = await page.evaluate(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-translated-subtitles"]');
      const state = document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]');
      const spinner = button ? getComputedStyle(button, '::before') : null;
      return {
        state: state?.textContent || '',
        busy: button?.getAttribute('aria-busy') || '',
        disabled: button?.hasAttribute('disabled') || false,
        spinnerContent: spinner?.content || '',
        spinnerAnimation: spinner?.animationName || '',
        spinnerWidth: spinner?.width || '',
      };
    });
    const translatedDownload = await translatedDownloadPromise;
    if (!translatedDownload) {
      throw new Error(`译文字幕下载事件超时：${translatedDownloadError instanceof Error ? translatedDownloadError.message : String(translatedDownloadError)}`);
    }
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu [data-download-status]')?.textContent === '已下载 · 2 条', null, { timeout: 30000 });
    const translatedDownloadPath = await translatedDownload.path();
    const translatedDownloadText = translatedDownloadPath ? fs.readFileSync(translatedDownloadPath, 'utf8') : '';
    const downloadEvidence = {
      originalFilename: originalDownload.suggestedFilename(),
      originalHasTimeline: originalDownloadText.includes('00:02:00,000 --> 00:02:01,600'),
      originalHasSource: downloadSources.every((source) => originalDownloadText.includes(source)),
      translatedFilename: translatedDownload.suggestedFilename(),
      translatedHasTimeline: translatedDownloadText.includes('00:02:00,000 --> 00:02:01,600'),
      translatedHasChinese: translatedDownloadText.includes('可下载的译文字幕。')
        && translatedDownloadText.includes('离线观看仍与时间轴同步。'),
      translatedOmitsSource: downloadSources.every((source) => !translatedDownloadText.includes(source)),
      slowTimedTextRequests,
      slowTimedTextRequestsAfterOriginal,
      originalInitialFeedback: originalDownloadInitialFeedback,
      originalSlowFeedback: originalDownloadSlowFeedback,
      originalFeedback: originalDownloadFeedback,
      translatedBusyFeedback: translatedDownloadBusyFeedback,
    };
    if (!downloadEvidence.originalFilename.endsWith('-en.srt') || !downloadEvidence.originalHasTimeline || !downloadEvidence.originalHasSource
      || !downloadEvidence.translatedFilename.endsWith('-zh-Hans-translated.srt') || !downloadEvidence.translatedHasTimeline
      || !downloadEvidence.translatedHasChinese || !downloadEvidence.translatedOmitsSource
      || downloadEvidence.slowTimedTextRequests < 1
      || downloadEvidence.slowTimedTextRequests !== downloadEvidence.slowTimedTextRequestsAfterOriginal
      || downloadEvidence.originalInitialFeedback.state !== '正在获取…' || downloadEvidence.originalInitialFeedback.busy !== 'true'
      || downloadEvidence.originalInitialFeedback.spinnerContent === 'none' || downloadEvidence.originalInitialFeedback.spinnerWidth !== '9px'
      || downloadEvidence.originalSlowFeedback.state !== '仍在读取…' || downloadEvidence.originalSlowFeedback.busy !== 'true'
      || downloadEvidence.originalFeedback.state !== '已下载 · 2 条' || downloadEvidence.originalFeedback.busy !== ''
      || !downloadEvidence.originalFeedback.disabled
      || downloadEvidence.translatedBusyFeedback.busy !== 'true' || !downloadEvidence.translatedBusyFeedback.disabled
      || !downloadEvidence.translatedBusyFeedback.state.startsWith('翻译 ')
      || downloadEvidence.translatedBusyFeedback.spinnerContent === 'none'
      || downloadEvidence.translatedBusyFeedback.spinnerWidth !== '9px') {
      throw new Error(`原文或译文字幕下载校验失败：${JSON.stringify(downloadEvidence)}`);
    }

    const overlaySelector = '#fluent-read-video-subtitle';
    const normalizedCaptionSelector = '#fluent-read-video-subtitle-original';
    const progressiveSource = 'understand from [music] the axioms and the basics.';
    const progressiveExpectedTranslation = '从音乐中理解公理和基础。';
    const progressiveRequestStart = translationSources.filter((source) => source === progressiveSource).length;
    await page.evaluate((source) => {
      const video = document.querySelector('video.html5-main-video');
      if (video) {
        try { video.currentTime = 0; } catch {}
        video.dispatchEvent(new Event('timeupdate'));
      }
      window.postMessage({
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en',
        responseText: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: source }] }] }),
      }, window.location.origin);
    }, progressiveSource);
    const pretranslationDeadline = Date.now() + 10000;
    while (translationSources.filter((source) => source === progressiveSource).length < 1 && Date.now() < pretranslationDeadline) {
      await page.waitForTimeout(100);
    }
    if (translationSources.filter((source) => source === progressiveSource).length !== 1) {
      // 失败诊断：用短前缀区分“轨道未接收”和“轨道已接收但时间轴没有触发预取”。
      await page.evaluate(() => {
        const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
        if (segment) segment.textContent = 'understand';
      });
      await page.waitForTimeout(1500);
      const progressiveDiagnostics = await page.evaluate(() => {
        const video = document.querySelector('video.html5-main-video');
        return {
          href: window.location.href,
          currentTime: video instanceof HTMLVideoElement ? video.currentTime : null,
          readyState: video instanceof HTMLVideoElement ? video.readyState : null,
          menuEnabled: document.querySelector('#fluent-read-video-subtitle-menu [data-mode="off"]')?.getAttribute('aria-checked') !== 'true',
          original: document.querySelector('#fluent-read-video-subtitle-original')?.textContent || '',
          translation: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
        };
      });
      throw new Error(`渐进字幕没有在播放前完成一次完整 cue 翻译：${JSON.stringify({ translationSources, progressiveDiagnostics })}`);
    }

    const progressiveTexts = [
      'understand',
      'understand from',
      'understand from [music]',
      'understand from [music] the axioms and',
    ];
    const progressiveVisibleTexts = [];
    for (const text of progressiveTexts) {
      await page.evaluate((value) => {
        const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
        if (segment) segment.textContent = value;
      }, text);
      await page.waitForFunction(({ expected, expectedTranslation }) => {
        const original = document.querySelector('#fluent-read-video-subtitle-original')?.textContent?.trim() || '';
        const translated = document.querySelector('#fluent-read-video-subtitle')?.textContent?.trim() || '';
        const native = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
        return original === expected
          && translated === expectedTranslation
          && native instanceof HTMLElement
          && getComputedStyle(native).visibility === 'hidden'
          && document.querySelector('#ytp-caption-window-container')?.classList.contains('fluent-read-video-normalized-caption');
      }, { expected: progressiveSource, expectedTranslation: progressiveExpectedTranslation }, { timeout: 10000 });
      const partialState = await page.evaluate(() => ({
        original: document.querySelector('#fluent-read-video-subtitle-original')?.textContent?.trim() || '',
        translation: document.querySelector('#fluent-read-video-subtitle')?.textContent?.trim() || '',
        nativeVisibility: document.querySelector('#ytp-caption-window-container .ytp-caption-segment')
          ? getComputedStyle(document.querySelector('#ytp-caption-window-container .ytp-caption-segment')).visibility
          : '',
        panelRect: document.querySelector('#fluent-read-video-subtitle-panel')?.getBoundingClientRect().toJSON() || null,
      }));
      progressiveVisibleTexts.push({
        source: text,
        original: partialState.original,
        translation: partialState.translation,
        nativeVisibility: partialState.nativeVisibility,
        panelRect: partialState.panelRect,
      });
    }
    if (progressiveVisibleTexts.some(({ original, translation, nativeVisibility }) => original !== progressiveSource || translation !== progressiveExpectedTranslation || nativeVisibility !== 'hidden')) {
      throw new Error(`逐词字幕没有被合并为完整原文并保留黄色译文：${JSON.stringify({ progressiveVisibleTexts })}`);
    }
    const panelBottoms = progressiveVisibleTexts
      .map(({ panelRect }) => panelRect?.bottom)
      .filter((bottom) => typeof bottom === 'number');
    const panelBottomRange = panelBottoms.length > 1
      ? Math.max(...panelBottoms) - Math.min(...panelBottoms)
      : Number.POSITIVE_INFINITY;
    if (panelBottomRange > 1.5) {
      throw new Error(`字幕面板底部随逐词输出发生跳动：${JSON.stringify({ panelBottomRange, progressiveVisibleTexts })}`);
    }
    await page.evaluate((value) => {
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = value;
    }, progressiveSource);
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent?.trim() === expected, { selector: overlaySelector, expected: progressiveExpectedTranslation }, { timeout: 20000 });
    const progressiveTranslation = await page.locator(overlaySelector).textContent();
    const translationPlacement = await page.evaluate(() => {
      const native = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      const normalized = document.querySelector('#fluent-read-video-subtitle-original');
      const overlay = document.querySelector('#fluent-read-video-subtitle');
      const panel = document.querySelector('#fluent-read-video-subtitle-panel');
      const player = document.querySelector('#movie_player, .html5-video-player');
      const nativeRect = native?.getBoundingClientRect();
      const normalizedRect = normalized?.getBoundingClientRect();
      const overlayRect = overlay?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const playerRect = player?.getBoundingClientRect();
      const style = overlay ? getComputedStyle(overlay) : null;
      const panelStyle = panel ? getComputedStyle(panel) : null;
      return {
        nativeTop: nativeRect?.top ?? null,
        normalizedTop: normalizedRect?.top ?? null,
        overlayBottom: overlayRect?.bottom ?? null,
        gap: normalizedRect && overlayRect ? normalizedRect.top - overlayRect.bottom : null,
        panelTop: panelRect?.top ?? null,
        panelBottom: panelRect?.bottom ?? null,
        panelBottomGap: panelRect && playerRect ? playerRect.bottom - panelRect.bottom : null,
        panelWidth: panelRect?.width ?? null,
        playerWidth: playerRect?.width ?? null,
        panelBottomStyle: panelStyle?.bottom || '',
        panelBackground: panelStyle?.backgroundColor || '',
        panelShadow: panelStyle?.boxShadow || '',
        panelRadius: panelStyle?.borderRadius || '',
        fontFamily: style?.fontFamily || '',
        color: style?.color || '',
        strokeWidth: style?.webkitTextStrokeWidth || '',
        textShadow: style?.textShadow || '',
        fontSize: style?.fontSize || '',
      };
    });
    if (translationPlacement.gap === null || translationPlacement.gap < 4 || !translationPlacement.fontFamily.includes('PingFang SC')
      || translationPlacement.color !== 'rgb(255, 228, 92)' || translationPlacement.strokeWidth === '0px'
      || translationPlacement.panelWidth <= 0 || translationPlacement.panelBackground === 'rgba(0, 0, 0, 0)'
      || translationPlacement.playerWidth === null || translationPlacement.panelWidth >= translationPlacement.playerWidth - 24
      || translationPlacement.panelShadow === 'none' || translationPlacement.panelRadius === '0px'
      || translationPlacement.panelBottomGap === null || translationPlacement.panelBottomGap < 48
      || translationPlacement.panelBottomGap > 100 || translationPlacement.panelBottomStyle === 'auto'
      || Number.parseFloat(translationPlacement.fontSize) <= 24) {
      throw new Error(`译文没有稳定显示在原字幕上方或字体清晰度样式未生效：${JSON.stringify(translationPlacement)}`);
    }
    const progressiveRequests = translationSources.filter((source) => source === progressiveSource).length - progressiveRequestStart;
    if (progressiveRequests !== 1) {
      throw new Error(`渐进字幕没有合并为单次完整 cue 翻译请求：${JSON.stringify({ progressiveRequests, translationSources })}`);
    }
    await page.screenshot({path: path.join(artifactsDir, 'video-subtitle-visible.png'), fullPage: false});

    await page.evaluate(() => {
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = 'and the housing market took a hit.';
    });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '房地产市场受到了冲击。', overlaySelector, { timeout: 20000 });
    const nativeCaptionPlacement = await page.evaluate(() => {
      const native = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      const panel = document.querySelector('#fluent-read-video-subtitle-panel');
      const player = document.querySelector('#movie_player, .html5-video-player');
      const nativeRect = native?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const playerRect = player?.getBoundingClientRect();
      const originalRect = document.querySelector('#fluent-read-video-subtitle-original')?.getBoundingClientRect();
      const translationRect = document.querySelector('#fluent-read-video-subtitle')?.getBoundingClientRect();
      return {
        nativeTop: nativeRect?.top ?? null,
        panelBottom: panelRect?.bottom ?? null,
        panelNativeGap: originalRect && translationRect ? originalRect.top - translationRect.bottom : null,
        playerBottom: playerRect?.bottom ?? null,
        panelBottomStyle: panel ? getComputedStyle(panel).bottom : '',
      };
    });
    if (nativeCaptionPlacement.panelNativeGap === null || nativeCaptionPlacement.panelNativeGap < 4) {
      throw new Error(`整段原生字幕被译文面板覆盖：${JSON.stringify(nativeCaptionPlacement)}`);
    }
    const beforeRedraw = await page.locator(overlaySelector).textContent();

    await page.evaluate(() => {
      const container = document.querySelector('#ytp-caption-window-container');
      if (!container) return;
      container.style.top = '0';
      container.style.height = '0';
      container.replaceChildren();
    });
    await page.waitForTimeout(180);
    const duringRedraw = await page.evaluate(() => ({
      nativeCaptionEmpty: !(document.querySelector('#ytp-caption-window-container')?.textContent || '').trim(),
      overlay: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
      overlayTop: document.querySelector('#fluent-read-video-subtitle')?.style.top || '',
    }));
    if (!duringRedraw.nativeCaptionEmpty || duringRedraw.overlay.trim()) {
      throw new Error(`字幕空档清理校验失败：${JSON.stringify(duringRedraw)}`);
    }

    await page.evaluate(() => {
      const container = document.querySelector('#ytp-caption-window-container');
      if (!container) return;
      container.style.top = '66%';
      container.style.height = '18%';
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = 'and the housing market took a hit.';
      container.appendChild(segment);
    });
    await page.waitForTimeout(600);
    const afterRedraw = await page.locator(overlaySelector).textContent();
    if (!afterRedraw?.trim()) throw new Error('字幕节点重建后译文没有恢复');

    await page.evaluate(() => {
      const container = document.querySelector('#ytp-caption-window-container');
      if (!container) return;
      container.style.top = '0';
      container.style.height = '0';
      container.replaceChildren();
    });
    await page.waitForTimeout(700);
    const afterDisappearance = await page.evaluate(() => ({
      nativeCaptionEmpty: !(document.querySelector('#ytp-caption-window-container')?.textContent || '').trim(),
      overlay: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
      overlayTop: document.querySelector('#fluent-read-video-subtitle')?.style.top || '',
    }));
    if (!afterDisappearance.nativeCaptionEmpty || afterDisappearance.overlay.trim() || Number.parseFloat(afterDisappearance.overlayTop) <= 8) {
      throw new Error(`字幕完全消失后的译文清理或位置校验失败：${JSON.stringify(afterDisappearance)}`);
    }

    await page.evaluate(() => {
      const container = document.querySelector('#ytp-caption-window-container');
      if (!container) return;
      container.style.top = '66%';
      container.style.height = '18%';
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = 'and the housing market took a hit.';
      container.appendChild(segment);
    });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '房地产市场受到了冲击。', overlaySelector, { timeout: 20000 });

    await page.evaluate(() => {
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = 'This is a FluentRead fixture subtitle.';
    });
    await page.waitForFunction((previous) => {
      const text = document.querySelector('#fluent-read-video-subtitle')?.textContent || '';
      return Boolean(text.trim() && text !== previous);
    }, afterRedraw, { timeout: 20000 });
    const secondTranslation = await page.locator(overlaySelector).textContent();

    const pretranslatedSource = 'This subtitle was translated in advance.';
    const prefetchRequestStart = translationSources.filter((source) => source === pretranslatedSource).length;
    await page.evaluate((source) => {
      const video = document.querySelector('video.html5-main-video');
      if (video) {
        try { video.currentTime = 0; } catch {}
        video.dispatchEvent(new Event('timeupdate'));
      }
      window.postMessage({
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en&kind=prefetch',
        responseText: JSON.stringify({ events: [{ tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: source }] }] }),
      }, window.location.origin);
    }, pretranslatedSource);
    await page.waitForTimeout(1200);
    const prefetchRequests = translationSources.filter((source) => source === pretranslatedSource).length - prefetchRequestStart;
    if (prefetchRequests !== 1) {
      throw new Error(`时间轴前置翻译没有提前请求一次：${JSON.stringify({ prefetchRequests, translationSources })}`);
    }
    await page.evaluate((source) => {
      document.querySelector('video.html5-main-video').currentTime = 8.2;
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = source;
    }, pretranslatedSource);
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '预先翻译的字幕。', overlaySelector, { timeout: 20000 });
    const displayedPrefetchTranslation = await page.locator(overlaySelector).textContent();
    const displayedPrefetchRequests = translationSources.filter((source) => source === pretranslatedSource).length;
    if (displayedPrefetchRequests - prefetchRequestStart !== 1) {
      throw new Error(`已前置翻译的字幕再次显示时重复请求：${JSON.stringify({ prefetchRequestStart, displayedPrefetchRequests, translationSources })}`);
    }

    await persistExtensionConfig(control, {
      videoService: 'openai',
      videoServiceDefaultMigrated: true,
      enableAIContext: true,
      useCache: false,
      token: { openai: 'fixture-token' },
      model: { openai: 'fixture-model' },
    });
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu [data-service-label]')?.textContent === 'OpenAI', null, { timeout: 10000 });
    const aiPretranslatedSource = 'This AI subtitle was translated in advance.';
    await page.evaluate((source) => {
      const video = document.querySelector('video.html5-main-video');
      if (video) {
        try { video.currentTime = 0; } catch {}
        video.dispatchEvent(new Event('timeupdate'));
      }
      window.postMessage({
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en&kind=ai',
        responseText: JSON.stringify({ events: [{ tStartMs: 20000, dDurationMs: 2000, segs: [{ utf8: source }] }] }),
      }, window.location.origin);
    }, aiPretranslatedSource);
    await page.waitForTimeout(1500);
    const aiPrefetchRequests = aiTranslationSources.filter((source) => source.includes(aiPretranslatedSource));
    if (aiPrefetchRequests.length !== 1) {
      throw new Error(`AI 字幕没有按 30 秒窗口前置翻译：${JSON.stringify({ aiTranslationSources })}`);
    }
    const aiContextRequests = aiTranslationSources.filter((source) => source.includes('FluentRead fixture context: this video explains orbital habitat economics and launch terminology.'));
    if (aiContextRequests.length === 0) {
      throw new Error(`AI 字幕请求没有注入页面上下文：${JSON.stringify({ aiTranslationSources })}`);
    }
    await page.evaluate((source) => {
      document.querySelector('video.html5-main-video').currentTime = 20.2;
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = source;
    }, aiPretranslatedSource);
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === 'AI预先翻译的字幕。', overlaySelector, { timeout: 20000 });
    const aiDisplayedPrefetchTranslation = await page.locator(overlaySelector).textContent();
    if (aiTranslationSources.filter((source) => source.includes(aiPretranslatedSource)).length !== 1) {
      throw new Error(`AI 已前置翻译的字幕再次显示时重复请求：${JSON.stringify({ aiTranslationSources })}`);
    }

    // 模拟 YouTube 原生字幕 DOM 仍停在上一句，但播放器时间已经进入下一条 cue。
    // 过期译文应立即撤下，等待原生文本也进入新句后再显示对应的双语。
    await persistExtensionConfig(control, {
      videoService: 'microsoft',
      videoServiceDefaultMigrated: true,
      useCache: false,
    });
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-menu [data-service-label]')?.textContent === '微软翻译', null, { timeout: 10000 });
    const timelineOldSource = 'Timeline subtitle is still visible.';
    const timelineNextSource = 'Timeline subtitle catches up.';
    await page.evaluate(({ oldSource, nextSource }) => {
      const video = document.querySelector('video.html5-main-video');
      if (video) {
        video.currentTime = 0;
        video.dispatchEvent(new Event('timeupdate'));
      }
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = oldSource;
      window.postMessage({
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=fixture-original-slow&lang=en&kind=timeline',
        responseText: JSON.stringify({ events: [
          { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: oldSource }] },
          { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: nextSource }] },
        ] }),
      }, window.location.origin);
    }, { oldSource: timelineOldSource, nextSource: timelineNextSource });
    await page.waitForFunction((expected) => document.querySelector('#fluent-read-video-subtitle')?.textContent === `【译文】${expected}`, timelineOldSource, { timeout: 20000 });
    await page.evaluate(() => {
      const video = document.querySelector('video.html5-main-video');
      if (video) {
        video.currentTime = 2.2;
        video.dispatchEvent(new Event('timeupdate'));
      }
    });
    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle')?.textContent
      && !document.querySelector('#fluent-read-video-subtitle-original')?.textContent);
    await page.evaluate(source => document.querySelector('#ytp-caption-window-container .ytp-caption-segment').textContent = source, timelineNextSource);
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle')?.textContent === '时间轴已追上字幕。'
      && document.querySelector('#fluent-read-video-subtitle-original')?.textContent === 'Timeline subtitle catches up.', null, {timeout: 20000});
    const timelineAlignment = await page.evaluate(() => ({
      translation: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
      normalized: document.querySelector('#fluent-read-video-subtitle-original')?.textContent || '',
      native: document.querySelector('#ytp-caption-window-container .ytp-caption-segment')?.textContent || '',
    }));


    // 逐字高亮默认关闭；开启后已显示的双语字幕立即拆成单元，并按当前句（2000–5000ms）的时间扫光。
    const readKaraoke = () => page.evaluate(() => Object.fromEntries(['fluent-read-video-subtitle-original', 'fluent-read-video-subtitle'].map((id) => {
      const line = document.getElementById(id);
      const units = Array.from(line?.querySelectorAll('.fluent-read-video-karaoke-unit') || []);
      const active = units.find(unit => unit.getAttribute('data-fluent-read-karaoke-state') === 'active');
      return [id, {
        text: line?.textContent || '',
        units: units.length,
        sung: units.filter(unit => unit.getAttribute('data-fluent-read-karaoke-state') === 'sung').length,
        activeIndex: active ? units.indexOf(active) : -1,
        fill: active ? Number.parseFloat(active.style.getPropertyValue('--fluent-read-video-karaoke-fill')) : null,
        clip: active ? getComputedStyle(active, '::after').clipPath : '',
        pendingColor: units.length ? getComputedStyle(units[units.length - 1]).color : '',
        lineColor: line ? getComputedStyle(line).color : '',
      }];
    })));
    const karaokeDefault = await readKaraoke();
    if (Object.values(karaokeDefault).some(line => line.units !== 0)) throw new Error(`逐字高亮应默认关闭：${JSON.stringify(karaokeDefault)}`);
    const karaokeAppearance = (await readExtensionConfig(control)).videoSubtitleAppearance || {};
    await persistExtensionConfig(control, {videoSubtitleAppearance: {...karaokeAppearance, karaoke: true}});
    await page.waitForFunction(() => ['fluent-read-video-subtitle-original', 'fluent-read-video-subtitle']
      .every(id => document.querySelector(`#${id} [data-fluent-read-karaoke-state="active"]`)), null, {timeout: 10000});
    const karaokeStart = await readKaraoke();
    await page.evaluate(() => {
      const video = document.querySelector('video.html5-main-video');
      video.currentTime = 3.6;
      video.dispatchEvent(new Event('timeupdate'));
    });
    await page.waitForFunction(() => document.querySelectorAll('#fluent-read-video-subtitle [data-fluent-read-karaoke-state="sung"]').length > 0, null, {timeout: 10000});
    const karaokeMiddle = await readKaraoke();
    await page.locator('#fluent-read-video-subtitle-panel').screenshot({ path: path.join(artifactsDir, 'video-subtitle-karaoke.png') });
    // 真实播放时由帧循环推进：同一句内高亮位置必须前进。
    await page.evaluate(() => document.querySelector('video.html5-main-video').play());
    await page.waitForFunction((before) => {
      const units = Array.from(document.querySelectorAll('#fluent-read-video-subtitle .fluent-read-video-karaoke-unit'));
      const active = units.findIndex(unit => unit.getAttribute('data-fluent-read-karaoke-state') === 'active');
      const fill = active < 0 ? 0 : Number.parseFloat(units[active].style.getPropertyValue('--fluent-read-video-karaoke-fill'));
      return active < 0 || active > before.activeIndex || fill > before.fill + 5;
    }, karaokeMiddle['fluent-read-video-subtitle'], {timeout: 10000});
    await page.evaluate(() => document.querySelector('video.html5-main-video').pause());
    const karaokePlaying = await readKaraoke();
    await page.evaluate(() => {
      const video = document.querySelector('video.html5-main-video');
      video.currentTime = 2.2;
      video.dispatchEvent(new Event('timeupdate'));
    });
    await page.waitForFunction(() => document.querySelectorAll('#fluent-read-video-subtitle [data-fluent-read-karaoke-state="sung"]').length === 0, null, {timeout: 10000});
    const karaokeRewound = await readKaraoke();
    await persistExtensionConfig(control, {videoSubtitleAppearance: {...karaokeAppearance, karaoke: false}});
    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-layer .fluent-read-video-karaoke-unit'), null, {timeout: 10000});
    const karaokeOff = await readKaraoke();
    const karaoke = {default: karaokeDefault, start: karaokeStart, middle: karaokeMiddle, playing: karaokePlaying, rewound: karaokeRewound, off: karaokeOff};
    for (const id of ['fluent-read-video-subtitle-original', 'fluent-read-video-subtitle']) {
      const [initial, start, middle, rewound, off] = [karaokeDefault[id], karaokeStart[id], karaokeMiddle[id], karaokeRewound[id], karaokeOff[id]];
      if (start.text !== initial.text || middle.text !== initial.text || off.text !== initial.text || off.units !== 0
        || start.units < 2 || start.activeIndex !== 0 || start.sung !== 0
        || middle.sung < 1 || middle.activeIndex !== middle.sung || !(middle.fill >= 0 && middle.fill <= 100)
        || !middle.clip.startsWith('inset(') || middle.pendingColor === middle.lineColor
        || rewound.activeIndex !== 0 || rewound.sung !== 0) {
        throw new Error(`逐字高亮状态不正确：${JSON.stringify(karaoke)}`);
      }
    }

    await page.locator('#fluent-read-video-subtitle-panel').screenshot({ path: path.join(artifactsDir, 'video-subtitle-panel.png') });
    await page.screenshot({ path: path.join(artifactsDir, 'video-subtitle-fixture-player.png'), fullPage: false });
    evidence = {
      ok: pageErrors.length === 0 && consoleErrors.length === 0 && unexpectedNetworkRequests.length === 0,
      suite,
      url,
      navigationMode,
      playerUi,
      menu,
      disabledMenu,
      reenabledFromSettings,
      popupFeature,
      initialVideoSettingsState,
      videoSettingsDescription,
      videoSettingsDisplayModes,
      videoSettingsDisplayModePersisted,
      crossContextDocumentConfig: {
        from: crossContextDocumentConfig.from,
        videoTranslationEnabled: crossContextDocumentConfig.videoTranslationEnabled,
        revision: crossContextDocumentConfig.__fluentConfigRevision,
      },
      videoToggleStability: {
        edges: videoToggleEdges,
        disabledRevision: disabledStabilitySamples[0]?.revision,
        enabledRevision: enabledStabilitySamples[0]?.revision,
        disabledSamples: disabledStabilitySamples.length,
        enabledSamples: enabledStabilitySamples.length,
      },
      beforeRedraw,
      nativeCaptionPlacement,
      duringRedraw,
      afterRedraw,
      afterDisappearance,
      progressiveTranslation,
      progressiveVisibleTexts,
      panelBottomRange,
      normalizedCaptionSelector,
      translationPlacement,
      progressiveRequests,
      secondTranslation,
      prefetchRequests,
      displayedPrefetchTranslation,
      displayedPrefetchRequests,
      aiDisplayedPrefetchTranslation,
      aiTranslationRequests: aiPrefetchRequests.length,
      aiContextRequests: aiContextRequests.length,
      timelineAlignment,
      karaoke,
      downloadEvidence,
      translationRequests,
      translationSources,
      pageErrors,
      consoleErrors,
      unexpectedNetworkRequests,
      artifactsDir,
      launchMode: browserSession.launchMode,
      focusPolicy: browserSession.focusPolicy,
      windowPlacement: browserSession.windowPlacement,
    };
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.ok) {
      throw new Error(`视频字幕浏览器回归未通过：${JSON.stringify({pageErrors, consoleErrors, unexpectedNetworkRequests})}`);
    }
  } catch (error) {primaryError = error; throw error;} finally {
    const cleanupErrors = [];
    let closed = false;
    if (browserSession) {
      try {await browserSession.close(); closed = true;}
      catch (error) {cleanupErrors.push(error);}
    }
    try {if (providerFixtureServer) await new Promise(resolve => {providerFixtureServer.close(resolve); providerFixtureServer.closeAllConnections();});}
    catch (error) {cleanupErrors.push(error);}
    let profileRemoved = false;
    try {
      if (closed) {fs.rmSync(profileDir, {recursive: true, force: true}); profileRemoved = true;}
      else if (!launchAttempted) {fs.rmdirSync(profileDir); profileRemoved = true;}
    } catch (error) {cleanupErrors.push(error);}
    if (!profileRemoved) console.error(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}`);
    if (evidence && (cleanupErrors.length || !profileRemoved)) {
      evidence.ok = false;
      evidence.cleanupErrors = cleanupErrors.map(error => String(error.stack || error));
      if (!profileRemoved) evidence.retainedProfile = profileDir;
      try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);}
      catch (error) {cleanupErrors.push(error);}
    }
    if (cleanupErrors.length) {
      for (const error of cleanupErrors) console.error(error.stack || error);
      process.exitCode = 1;
      if (!primaryError) throw cleanupErrors[0];
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
