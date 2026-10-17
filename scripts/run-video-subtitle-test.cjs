#!/usr/bin/env node

const {waitForAsyncCondition} = require('./testing/wait-for-async-condition.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

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
  try { return require('playwright'); } catch {
    const runtimeRequire = createRequire(path.join(path.resolve(root), '__fluentread_video_test__.cjs'));
    return runtimeRequire('playwright');
  }
}

function readArg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function parseArgs(argv, env = process.env) {
  const args = {
    extensionDir: readArg(argv, 'extension-dir', '.output/chrome-mv3-dev'),
    playwrightRoot: readArg(argv, 'playwright-root', env.PLAYWRIGHT_ROOT),
    url: readArg(argv, 'url', 'https://www.youtube.com/watch?v=drSMZgnmJjk'),
    artifactsDir: readArg(argv, 'artifacts-dir', path.join(os.tmpdir(), 'fluentread-video-subtitle-evidence')),
    browserPath: readArg(argv, 'browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    focusSafeHelper: readArg(argv, 'focus-safe-helper', env.FLUENTREAD_FOCUS_SAFE_HELPER || ''),
    background: !argv.includes('--headed'),
  };
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root 或设置 PLAYWRIGHT_ROOT');
  if (args.background && !args.focusSafeHelper) {
    throw new Error('后台模式必须传入 --focus-safe-helper 或设置 FLUENTREAD_FOCUS_SAFE_HELPER');
  }
  args.extensionDir = path.resolve(args.extensionDir);
  args.artifactsDir = path.resolve(args.artifactsDir);
  if (args.focusSafeHelper) args.focusSafeHelper = path.resolve(args.focusSafeHelper);
  return args;
}

function loadFocusSafeBrowser(helperPath) {
  if (!fs.existsSync(helperPath)) throw new Error(`找不到后台浏览器辅助脚本：${helperPath}`);
  const helper = require(helperPath);
  for (const name of [
    'launchFocusSafePersistentContext',
    'newPageWithoutForeground',
    'activateExtensionTabWithoutForeground',
  ]) {
    if (typeof helper[name] !== 'function') throw new Error(`后台浏览器辅助脚本缺少接口：${name}`);
  }
  return helper;
}

function assertDedicatedTemporaryProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝使用非临时浏览器 profile：${resolved}`);
  }
}

const videoTestConfigClientId = `video-subtitle-test-${process.pid}-${Date.now()}`;
let videoTestConfigSequence = 0;

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
  const current = await readExtensionConfig(extensionPage);
  const sequence = ++videoTestConfigSequence;
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
    clientId: videoTestConfigClientId,
    currentConfig: current,
    configPatch: patch,
    requestSequence: sequence,
  });
  if (response?.success !== true) {
    throw new Error(`视频字幕配置保存失败：${JSON.stringify(response)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {extensionDir, playwrightRoot, url, artifactsDir, browserPath} = args;
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`找不到扩展构建：${extensionDir}`);
  if (!fs.existsSync(browserPath)) throw new Error(`找不到浏览器：${browserPath}`);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-edge-video-profile-'));
  assertDedicatedTemporaryProfile(profileDir);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const { chromium } = loadPlaywright(playwrightRoot);
  const browserArgs = [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run', '--no-default-browser-check',
  ];
  let context;
  let closeBrowser = async () => { if (context) await context.close().catch(() => undefined); };
  let createIsolatedPage;
  let activateTestPage = async () => undefined;
  let launchMode;
  let focusPolicy;
  let windowPlacement;
  try {
    if (args.background) {
      const focusSafe = loadFocusSafeBrowser(args.focusSafeHelper);
      const browserSession = await focusSafe.launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath,
        headless: false,
        background: true,
        browserArgs,
        viewport: { width: 1280, height: 900 },
      });
      context = browserSession.context;
      closeBrowser = browserSession.close;
      createIsolatedPage = () => focusSafe.newPageWithoutForeground(context);
      activateTestPage = page => focusSafe.activateExtensionTabWithoutForeground(context, page);
      launchMode = browserSession.launchMode;
      focusPolicy = browserSession.focusPolicy;
      windowPlacement = browserSession.windowPlacement;
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: browserPath,
        headless: false,
        args: browserArgs,
        viewport: { width: 1280, height: 900 },
      });
      closeBrowser = () => context.close();
      createIsolatedPage = () => context.newPage();
      launchMode = 'playwright-headed';
      focusPolicy = 'foreground-authorized';
      windowPlacement = { mode: 'headed-explicit-foreground', windowState: 'normal', viewport: { width: 1280, height: 900 } };
    }

    const workers = context.serviceWorkers();
    const worker = workers[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) throw new Error('无法取得扩展 ID');

    const popup = await createIsolatedPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await activateTestPage(popup);
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout: 15000});
    await persistExtensionConfig(popup, {
      on: true,
      display: 1,
      from: 'auto',
      to: 'zh-Hans',
      service: 'deeplx',
      videoTranslationEnabled: true,
      uiLanguage: 'zh-CN',
      uiLanguageSetupCompleted: true,
      useCache: false,
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout: 15000});
    await popup.waitForFunction(
      () => !document.querySelector('[data-testid="ui-language-onboarding"]'),
      null,
      { timeout: 10000 },
    );
    const popupConfig = await readExtensionConfig(popup);
    // 当前 Popup 的视频服务入口位于服务分配列表，总开关在完整视频设置中。
    await popup.locator('[data-testid="popup-feature-services"]').click();
    const servicePanel = popup.locator('.popup-service-panel');
    await servicePanel.locator('[data-feature-service="video"]').waitFor({state: 'visible', timeout: 10000});
    const popupState = await popup.evaluate((config) => {
      const row = document.querySelector('.popup-service-panel [data-feature-service="video"]');
      return {
        videoServiceAssignmentPresent: Boolean(row),
        videoServiceAssignmentSummary: row?.querySelector('.assignment-value')?.textContent?.trim() || '',
        betaMarkers: [...(row?.querySelectorAll('*') || [])].filter(node => /beta|测试版/iu.test(node.textContent || '')).length,
        popupHeight: document.body.scrollHeight,
        config,
      };
    }, popupConfig);
    if (!popupState.videoServiceAssignmentPresent || !popupState.videoServiceAssignmentSummary
      || popupState.betaMarkers !== 0 || popupState.config.videoService !== 'microsoft') {
      throw new Error(`Popup 视频服务分配入口校验失败：${JSON.stringify(popupState)}`);
    }
    const videoServiceAssignmentState = {
      entryPresent: popupState.videoServiceAssignmentPresent,
      summary: popupState.videoServiceAssignmentSummary,
    };
    await popup.screenshot({path: path.join(artifactsDir, 'popup-video-service-assignment.png'), fullPage: true});
    await popup.close();

    const options = await createIsolatedPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#settings-video`, { waitUntil: 'domcontentloaded' });
    await activateTestPage(options);
    await options.getByRole('heading', { name: '视频字幕翻译' }).waitFor({ timeout: 15000 });
    const optionsState = await options.evaluate(() => ({
      activeNav: document.querySelector('.sidebar button.active')?.textContent?.replace(/\s+/g, ' ').trim(),
      videoSection: Boolean(document.querySelector('#settings-video')),
      providerControl: Boolean(document.querySelector('[aria-label="视频字幕翻译服务"]')),
    }));
    if (!optionsState.activeNav?.includes('视频字幕翻译') || !optionsState.videoSection || !optionsState.providerControl) {
      throw new Error(`视频字幕设置导航校验失败：${JSON.stringify(optionsState)}`);
    }
    await options.screenshot({ path: path.join(artifactsDir, 'options-video-subtitle.png'), fullPage: true });
    await options.close();

    const page = await createIsolatedPage();
    const extensionPageErrors = [];
    page.on('pageerror', (error) => {
      const message = error.stack || error.message || String(error);
      if (message.includes('chrome-extension://')) extensionPageErrors.push(message);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await activateTestPage(page);
    await page.waitForTimeout(6000);

    await page.waitForFunction(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-button');
      return Boolean(button?.closest('.ytp-right-controls'));
    }, null, { timeout: 20000 });
    const playerUiState = await page.evaluate(() => {
      const button = document.querySelector('#fluent-read-video-subtitle-button');
      return {
        buttonPresent: Boolean(button),
        buttonInRightControls: Boolean(button?.closest('.ytp-right-controls')),
        buttonEnabled: Boolean(button?.classList.contains('fluent-read-video-subtitle-active')),
        buttonLabel: button?.getAttribute('aria-label'),
      };
    });
    if (!playerUiState.buttonPresent || !playerUiState.buttonInRightControls || !playerUiState.buttonEnabled) {
      throw new Error(`播放器字幕翻译入口校验失败：${JSON.stringify(playerUiState)}`);
    }

    const clickVideoTranslationButton = () => page.locator('#fluent-read-video-subtitle-button').click();

    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), false);
    await clickVideoTranslationButton();
    await page.locator('#fluent-read-video-subtitle-menu').waitFor({ state: 'visible', timeout: 10000 });
    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), true);
    const playerMenuState = await page.evaluate(() => ({
      title: document.querySelector('#fluent-read-video-subtitle-menu .fluent-read-video-menu-title')?.textContent?.replace(/\s+/g, ' ').trim(),
      modeCount: document.querySelectorAll('#fluent-read-video-subtitle-menu [data-mode]').length,
      modes: [...document.querySelectorAll('#fluent-read-video-subtitle-menu [data-mode]')].map(node => node.getAttribute('data-mode')),
      downloadPresent: Boolean(document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]')),
      bilingualSelected: document.querySelector('#fluent-read-video-subtitle-menu [data-mode="bilingual"]')?.getAttribute('aria-checked') === 'true',
      service: document.querySelector('#fluent-read-video-subtitle-menu [data-service-label]')?.textContent,
      brand: document.querySelector('#fluent-read-video-subtitle-menu .fluent-read-video-menu-brand')?.textContent,
      betaMarkers: [...document.querySelectorAll('#fluent-read-video-subtitle-menu *')]
        .filter((node) => /beta|测试版/iu.test(node.textContent || '')).length,
    }));
    if (playerMenuState.modeCount !== 4 || JSON.stringify(playerMenuState.modes) !== JSON.stringify(['bilingual', 'translation-only', 'original-only', 'off']) || !playerMenuState.downloadPresent || !playerMenuState.bilingualSelected || playerMenuState.service !== '微软翻译' || playerMenuState.brand !== '流畅阅读' || playerMenuState.betaMarkers !== 0) {
      throw new Error(`播放器字幕翻译菜单校验失败：${JSON.stringify(playerMenuState)}`);
    }
    await page.screenshot({ path: path.join(artifactsDir, 'youtube-video-subtitle-menu.png'), fullPage: false });
    const playerSettingsPagePromise = context.waitForEvent('page', { timeout: 10000 });
    await page.locator('#fluent-read-video-subtitle-menu [data-action="open-settings"]').click({ force: true });
    const playerSettingsPage = await playerSettingsPagePromise;
    await playerSettingsPage.waitForLoadState('domcontentloaded');
    const playerSettingsState = {
      opened: true,
      videoHash: playerSettingsPage.url().endsWith('#settings-video'),
    };
    await playerSettingsPage.close();

    const subtitleButton = page.locator('button.ytp-subtitles-button').first();
    if (await subtitleButton.count()) {
      if (await subtitleButton.getAttribute('aria-pressed') !== 'true') await subtitleButton.click();
      await page.waitForTimeout(2500);
    }

    const playButton = page.locator('button.ytp-play-button').first();
    if (await playButton.count() && (await playButton.getAttribute('aria-label') || '').toLowerCase().includes('play')) {
      await playButton.click().catch(() => undefined);
      await page.waitForTimeout(5000);
    }
    const nativeSubtitle = await page.locator('.ytp-caption-segment').first().count();
    await clickVideoTranslationButton();
    await page.locator('#fluent-read-video-subtitle-menu').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => {
      window.postMessage({
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=dqONk48l5vY&lang=en',
        responseText: JSON.stringify({ events: [
          { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Download test subtitle.' }] },
          { tStartMs: 1500, dDurationMs: 1200, segs: [{ utf8: 'The SRT export works.' }] },
        ] }),
      }, window.location.origin);
    });
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]').click({ force: true });
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const downloadedText = downloadPath ? fs.readFileSync(downloadPath, 'utf8') : '';
    const downloadState = {
      suggestedFilename: download.suggestedFilename(),
      hasTimestamp: downloadedText.includes('00:00:00,000 --> 00:00:01,200'),
      hasSubtitle: downloadedText.includes('Download test subtitle.'),
    };
    if (!downloadState.hasTimestamp || !downloadState.hasSubtitle) {
      throw new Error(`字幕 SRT 下载内容校验失败：${JSON.stringify(downloadState)}`);
    }
    const injected = await page.evaluate(() => {
      let container = document.querySelector('#ytp-caption-window-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'ytp-caption-window-container';
        document.body.appendChild(container);
      }
      container.replaceChildren();
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = 'This is a FluentRead video subtitle test.';
      container.appendChild(segment);
      return Boolean(container);
    });
    await page.waitForFunction(() => {
      const overlay = document.querySelector('#fluent-read-video-subtitle');
      return Boolean(overlay?.textContent?.match(/[\u3400-\u9fff]/));
    }, null, { timeout: 45000 });
    const first = await page.locator('#fluent-read-video-subtitle').textContent();

    await page.evaluate(() => {
      document.querySelector('#ytp-caption-window-container, .ytp-caption-window-container')?.replaceChildren();
    });
    await page.waitForTimeout(180);
    const duringCaptionRedraw = await page.evaluate(() => ({
      nativeCaptionEmpty: !(document.querySelector('#ytp-caption-window-container, .ytp-caption-window-container')?.textContent || '').trim(),
      overlay: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
    }));
    if (!duringCaptionRedraw.nativeCaptionEmpty || !duringCaptionRedraw.overlay.trim()) {
      throw new Error(`字幕节点短暂重绘时译文被清除：${JSON.stringify(duringCaptionRedraw)}`);
    }
    await page.evaluate(() => {
      const container = document.querySelector('#ytp-caption-window-container, .ytp-caption-window-container');
      if (!container) return;
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = 'This is a FluentRead video subtitle test.';
      container.appendChild(segment);
    });
    await page.waitForTimeout(600);
    const afterCaptionRedraw = await page.locator('#fluent-read-video-subtitle').textContent();
    if (!afterCaptionRedraw?.trim()) {
      throw new Error('字幕节点重建后译文没有恢复');
    }

    await page.evaluate(() => {
      const segment = document.querySelector('#ytp-caption-window-container .ytp-caption-segment');
      if (segment) segment.textContent = 'The second subtitle updates correctly.';
    });
    await page.waitForFunction((oldText) => {
      const overlay = document.querySelector('#fluent-read-video-subtitle');
      return Boolean(overlay?.textContent?.trim() && overlay.textContent !== oldText);
    }, first, { timeout: 45000 });
    const second = await page.locator('#fluent-read-video-subtitle').textContent();
    const overlayCount = await page.locator('#fluent-read-video-subtitle').count();

    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-menu [data-action="download-subtitles"]')?.hasAttribute('disabled'), null, { timeout: 10000 });
    await clickVideoTranslationButton();
    await page.locator('#fluent-read-video-subtitle-menu').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#fluent-read-video-subtitle-menu [data-mode="translation-only"]').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#ytp-caption-window-container')?.classList.contains('fluent-read-video-display-translation-only'), null, { timeout: 10000 });
    const translationOnly = await page.evaluate(() => document.querySelector('#ytp-caption-window-container')?.getAttribute('data-fluent-read-video-display-mode'));

    await page.locator('#fluent-read-video-subtitle-menu [data-mode="bilingual"]').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#ytp-caption-window-container')?.getAttribute('data-fluent-read-video-display-mode') === 'bilingual', null, { timeout: 10000 });

    await page.locator('#fluent-read-video-subtitle-menu [data-mode="off"]').click();
    await page.waitForFunction(() => !document.querySelector('#fluent-read-video-subtitle-button')
      && !document.querySelector('#fluent-read-video-subtitle-menu')
      && !document.querySelector('#fluent-read-video-subtitle')?.textContent?.trim(), null, {timeout: 10000});
    const disabledFromPlayer = await page.evaluate(() => ({
      buttonPresent: Boolean(document.querySelector('#fluent-read-video-subtitle-button')),
      menuPresent: Boolean(document.querySelector('#fluent-read-video-subtitle-menu')),
      overlayText: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
    }));
    await page.screenshot({path: path.join(artifactsDir, 'youtube-video-subtitle-disabled.png'), fullPage: false});

    // 关闭后入口和菜单已销毁；从扩展设置的真实控件重新启用。
    const reenableSettings = await createIsolatedPage();
    try {
      await reenableSettings.goto(`chrome-extension://${extensionId}/options.html#settings-video`, {waitUntil: 'domcontentloaded'});
      await activateTestPage(reenableSettings);
      await waitForAsyncCondition(async () => (await readExtensionConfig(reenableSettings)).videoTranslationEnabled === false,
        {timeoutMs: 10000, message: '播放器关闭视频未持久化'});
      const toggle = reenableSettings.locator('#settings-video').getByRole('switch', {name: '视频字幕翻译', exact: true});
      await toggle.waitFor({state: 'visible', timeout: 10000});
      if (await toggle.getAttribute('aria-checked') !== 'false') throw new Error('设置页未显示视频关闭状态');
      await toggle.click();
      await reenableSettings.waitForFunction(() => document.querySelector('#settings-video .feature-enable-card [role="switch"]')?.getAttribute('aria-checked') === 'true', null, {timeout: 10000});
      await waitForAsyncCondition(async () => (await readExtensionConfig(reenableSettings)).videoTranslationEnabled === true,
        {timeoutMs: 10000, message: '从设置页重新启用视频未持久化'});
      await reenableSettings.screenshot({path: path.join(artifactsDir, 'youtube-video-subtitle-settings-reenabled.png'), fullPage: true});
    } finally {
      await reenableSettings.close();
    }
    await activateTestPage(page);
    await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-button')?.classList.contains('fluent-read-video-subtitle-active') === true
      && document.querySelector('#fluent-read-video-subtitle-menu')?.hidden === true, null, {timeout: 10000});
    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), false);
    await clickVideoTranslationButton();
    await page.locator('#fluent-read-video-subtitle-menu').waitFor({state: 'visible', timeout: 10000});
    await page.evaluate(() => {
      let container = document.querySelector('#ytp-caption-window-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'ytp-caption-window-container';
        document.body.appendChild(container);
      }
      container.replaceChildren();
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      segment.textContent = 'The subtitle returns after the player toggle.';
      container.appendChild(segment);
    });
    await page.waitForFunction(() => {
      const overlay = document.querySelector('#fluent-read-video-subtitle');
      return Boolean(overlay?.textContent?.match(/[\u3400-\u9fff]/));
    }, null, { timeout: 45000 });
    assertPlayerMenuButtonState(await readPlayerMenuButtonState(page), true);
    const reenabledFromSettings = await page.evaluate(() => ({
      buttonActive: Boolean(document.querySelector('#fluent-read-video-subtitle-button')?.classList.contains('fluent-read-video-subtitle-active')),
      overlayText: document.querySelector('#fluent-read-video-subtitle')?.textContent || '',
    }));

    if (extensionPageErrors.length > 0) {
      throw new Error(`播放器页面出现扩展脚本异常：${extensionPageErrors.join('\n')}`);
    }

    await clickVideoTranslationButton();
    await page.screenshot({ path: path.join(artifactsDir, 'youtube-video-subtitle-final.png'), fullPage: false });

    console.log(JSON.stringify({
      ok: true,
      url: page.url(),
      popupState: {
        videoServiceAssignmentPresent: popupState.videoServiceAssignmentPresent,
        videoServiceAssignmentSummary: popupState.videoServiceAssignmentSummary,
        popupHeight: popupState.popupHeight,
        textService: popupState.config.service,
        videoService: popupState.config.videoService,
        videoTranslationEnabled: popupState.config.videoTranslationEnabled,
      },
      videoServiceAssignmentState,
      optionsState,
      playerUiState,
      playerMenuState,
      playerSettingsState,
      downloadState,
      nativeSubtitle,
      injected,
      firstTranslation: first,
      duringCaptionRedraw,
      afterCaptionRedraw,
      secondTranslation: second,
      overlayCount,
      translationOnly,
      disabledFromPlayer,
      reenabledFromSettings,
      extensionPageErrors,
      disabledClearedOverlay: !disabledFromPlayer.buttonPresent && !disabledFromPlayer.menuPresent && disabledFromPlayer.overlayText === '',
      artifactsDir,
      launchMode,
      focusPolicy,
      windowPlacement,
    }, null, 2));
  } finally {
    await closeBrowser();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs};
