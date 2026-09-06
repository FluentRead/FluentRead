#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');

function fail(message) { throw new Error(message); }

let newPageWithoutForeground;

function args(argv) {
  const result = {
    extensionDir: '',
    artifactsDir: '/private/tmp/video-subtitle-settings-proof',
    playwrightRoot: '',
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    focusSafeHelper: '',
    extensionInstall: 'cdp',
    background: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--headed') { result.background = false; continue; }
    if (!token.startsWith('--')) fail(`无法识别参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`参数缺少值：${token}`);
    result[key] = value;
    index += 1;
  }
  if (!result.extensionDir) fail('必须传入 --extension-dir');
  if (!result.focusSafeHelper) fail('必须传入 --focus-safe-helper');
  return result;
}

function loadPlaywright(root) {
  try { return require('playwright'); } catch (error) {
    if (!root) throw error;
    return createRequire(path.join(path.resolve(root), '__fluentread_settings_loader__.cjs'))('playwright');
  }
}

async function waitWorker(context, manifest, timeout = 30000) {
  const matches = async () => {
    for (const worker of context.serviceWorkers()) {
      try {
        const loaded = await worker.evaluate(() => chrome.runtime.getManifest());
        if (loaded?.action?.default_popup === manifest.action?.default_popup
          && (loaded?.options_ui?.page || loaded?.options_page) === (manifest.options_ui?.page || manifest.options_page)) {
          return worker;
        }
      } catch {
        // Component workers and non-extension targets are not the loaded FluentRead worker.
      }
    }
    return null;
  };
  const worker = await matches() || await new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 FluentRead 扩展 worker 超时')), timeout);
    const onWorker = async (candidate) => {
      try {
        const loaded = await candidate.evaluate(() => chrome.runtime.getManifest());
        if (loaded?.action?.default_popup === manifest.action?.default_popup
          && (loaded?.options_ui?.page || loaded?.options_page) === (manifest.options_ui?.page || manifest.options_page)) {
          clearTimeout(timer);
          resolve(candidate);
        }
      } catch {
        // Ignore unrelated workers.
      }
    };
    context.on('serviceworker', onWorker);
  });
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) fail(`扩展 worker URL 无法解析：${worker.url()}`);
  return {worker, extensionId: match[1]};
}

async function openExtensionPage(context, url, viewport) {
  const page = await newPageWithoutForeground(context, 10000);
  await page.setViewportSize(viewport);
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
  return page;
}

async function screenshot(page, file) {
  await page.screenshot({path: file, fullPage: true});
}

async function selectOptionsVideo(page) {
  const nav = page.locator('button[data-section="settings-video"]');
  await nav.waitFor({state: 'visible', timeout: 30000});
  await nav.click();
  await page.locator('#settings-video').waitFor({state: 'visible', timeout: 30000});
}

async function setRange(page, label, value) {
  const input = page.locator(`input[aria-label="${label}"]`);
  const aligned = await input.evaluate((element, requested) => {
    const min = Number(element.getAttribute('min') || requested);
    const max = Number(element.getAttribute('max') || requested);
    const step = Number(element.getAttribute('step') || 1);
    return Math.min(max, Math.max(min, min + Math.round((requested - min) / step) * step));
  }, value);
  await input.fill(String(aligned));
  await input.dispatchEvent('change');
}

async function selectVideoSourceLanguage(page, label) {
  const combobox = page.getByRole('combobox', {name: '视频原语言'});
  await combobox.click({force: true});
  const option = page.locator('[role="option"]:visible').filter({hasText: label}).first();
  await option.waitFor({state: 'visible', timeout: 30000});
  await option.click();
}

async function selectedVideoSourceLanguage(page) {
  return page.locator('#settings-video [role="combobox"][aria-label="视频原语言"]')
    .evaluate(element => element.closest('.el-select')?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() || '');
}

async function main() {
  const options = args(process.argv.slice(2));
  const playwright = loadPlaywright(options.playwrightRoot);
  const focusSafeBrowser = require(path.resolve(options.focusSafeHelper));
  const {launchFocusSafePersistentContext} = focusSafeBrowser;
  newPageWithoutForeground = focusSafeBrowser.newPageWithoutForeground;
  const extensionDir = path.resolve(options.extensionDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  const optionsPath = manifest.options_ui?.page || manifest.options_page;
  if (!popupPath || !optionsPath) fail('清单缺少 popup/options entrypoint');
  fs.mkdirSync(options.artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-video-settings-'));
  const result = {
    success: false,
    extensionDir,
    profileDir,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    skinCases: [],
    persistence: {},
    popup: {},
    screenshots: [],
    consoleErrors: [],
  };
  let session;
  try {
    session = await launchFocusSafePersistentContext({
      chromium: playwright.chromium,
      profileDir,
      browserPath: options.browserPath,
      headless: false,
      background: options.background,
      displayTarget: 'secondary',
      viewport: {width: 1440, height: 1000},
      browserArgs: [
        ...(options.extensionInstall === 'cdp'
          ? ['--enable-unsafe-extension-debugging']
          : [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]),
        '--no-first-run',
        '--no-default-browser-check',
      ],
      timeout: 30000,
    });
    result.launchMode = session.launchMode;
    result.focusPolicy = session.focusPolicy;
    result.windowPlacement = session.windowPlacement;
    let extensionId;
    if (options.extensionInstall === 'cdp') {
      const extensionSession = await session.context.browser().newBrowserCDPSession();
      extensionId = (await extensionSession.send('Extensions.loadUnpacked', {path: extensionDir})).id;
      await extensionSession.detach();
    }
    extensionId ||= (await waitWorker(session.context, manifest)).extensionId;
    const optionsUrl = `chrome-extension://${extensionId}/${optionsPath}`;
    const popupUrl = `chrome-extension://${extensionId}/${popupPath}`;
    const optionsPage = await openExtensionPage(session.context, optionsUrl, {width: 1440, height: 1000});
    optionsPage.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    optionsPage.on('pageerror', error => result.consoleErrors.push(error.message));
    await optionsPage.locator('.settings-app').waitFor({state: 'visible', timeout: 30000});
    await selectOptionsVideo(optionsPage);
    const translationToggle = optionsPage.locator('#settings-video [aria-label="视频字幕翻译"]');
    if (await translationToggle.getAttribute('aria-checked') !== 'true') {
      await translationToggle.locator('xpath=ancestor::*[contains(@class, "el-switch")]').click({force: true});
    }
    await optionsPage.evaluate(async () => {
      await chrome.storage.local.set({fluentReadVideoLocalTranscriptionModels: ['tiny', 'base']});
      await chrome.runtime.sendMessage({
        type: 'fluentReadSetVideoAiSubtitleCache',
        source: {statusUrl: 'https://x.com/settings-proof/status/123456789', mediaId: 'settings-proof-media'},
        model: 'tiny',
        videoSourceLanguage: 'ko',
        cues: [{startMs: 0, durationMs: 1_200, spokenEndMs: 1_000, text: 'Settings cache proof.'}],
      });
    });
    await optionsPage.reload({waitUntil: 'domcontentloaded'});
    await optionsPage.locator('.settings-app').waitFor({state: 'visible', timeout: 30000});
    await selectOptionsVideo(optionsPage);
    const reloadedTranslationToggle = optionsPage.locator('#settings-video [aria-label="视频字幕翻译"]');
    if (await reloadedTranslationToggle.getAttribute('aria-checked') !== 'true') {
      await reloadedTranslationToggle.locator('xpath=ancestor::*[contains(@class, "el-switch")]').click({force: true});
    }
    await optionsPage.waitForFunction(() => document.querySelector('.video-model-status')?.textContent.includes('当前模型已下载'));
    result.modelState = {fixtureMetadata:true,downloaded:['tiny','base'],managementCollapsed:false};
    await screenshot(optionsPage, path.join(options.artifactsDir, 'options-model-downloaded.png'));
    result.screenshots.push(path.join(options.artifactsDir, 'options-model-downloaded.png'));

    const modelManagement = optionsPage.locator('.video-model-management');
    await modelManagement.locator('.video-model-card').first().waitFor({state: 'visible'});
    result.modelDescriptions = await modelManagement.locator('.video-model-description').allTextContents();
    await screenshot(optionsPage, path.join(options.artifactsDir, 'options-model-descriptions.png'));
    result.screenshots.push(path.join(options.artifactsDir, 'options-model-descriptions.png'));

    const skinButtons = optionsPage.locator('[data-video-subtitle-appearance] button[data-skin]');
    const skinIds = await skinButtons.evaluateAll(items => items.map(item => item.getAttribute('data-skin')).filter(Boolean));
    if (skinIds.length !== 8) fail(`字幕皮肤数量应为 8，实际 ${skinIds.length}`);
    for (const skinId of skinIds) {
      await optionsPage.locator(`[data-video-subtitle-appearance] button[data-skin="${skinId}"]`).click();
      const preview = optionsPage.locator('[data-video-subtitle-preview]');
      const style = await preview.getAttribute('style');
      if (!style || !style.includes('--fluent-read-video-subtitle-background')) fail(`皮肤 ${skinId} 未更新预览 CSS 变量`);
      result.skinCases.push({skinId, style});
    }
    await optionsPage.locator('details.subtitle-appearance-advanced').evaluate(element => { element.open = true; });
    await setRange(optionsPage, '字幕字号', 130);
    await setRange(optionsPage, '字幕底部偏移', 16);
    if (await optionsPage.getByRole('checkbox', {name: 'X 字幕自动贴底'}).isChecked()) fail('手动偏移应关闭 X 自动贴底');
    await setRange(optionsPage, '字幕背景透明度', 44);
    await setRange(optionsPage, '字幕行距', 1.45);
    await setRange(optionsPage, '字幕最大宽度', 78);
    await optionsPage.locator('[data-video-subtitle-appearance] select[aria-label="字幕位置"]').selectOption('top');
    const reset = optionsPage.getByRole('button', {name: '恢复默认'});
    await reset.click();
    if (!(await optionsPage.getByRole('checkbox', {name: 'X 字幕自动贴底'}).isChecked())) fail('恢复默认应启用 X 自动贴底');
    const resetState = await optionsPage.locator('[data-video-subtitle-appearance]').evaluate(element => ({
      skin: element.querySelector('[data-skin].selected')?.getAttribute('data-skin'),
      fontScale: element.querySelector('input[aria-label="字幕字号"]')?.value,
      position: element.querySelector('select[aria-label="字幕位置"]')?.value,
    }));
    if (resetState.skin !== 'classic' || resetState.fontScale !== '100' || resetState.position !== 'bottom') fail(`恢复默认状态不正确：${JSON.stringify(resetState)}`);

    await optionsPage.locator('[data-video-subtitle-appearance] button[data-skin="terminal"]').click();
    await setRange(optionsPage, '字幕字号', 130);
    await selectVideoSourceLanguage(optionsPage, '한국어');
    await optionsPage.waitForTimeout(500);
    result.persistence.beforeClose = await optionsPage.locator('#settings-video').evaluate(element => ({
      sourceLanguage: element.querySelector('[role="combobox"][aria-label="视频原语言"]')?.closest('.el-select')?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim(),
      skin: element.querySelector('[data-video-subtitle-appearance] [data-skin].selected')?.getAttribute('data-skin'),
      fontScale: element.querySelector('[data-video-subtitle-appearance] input[aria-label="字幕字号"]')?.value,
      enabled: element.querySelector('[aria-label="视频字幕翻译"]')?.getAttribute('aria-checked'),
    }));
    const cachePanel = optionsPage.locator('[data-video-ai-cache]');
    const cacheStatus = await cachePanel.locator('[role="status"]').textContent();
    const clearCacheButton = cachePanel.getByRole('button', {name: '清除缓存'});
    const cacheBeforeClear = {status: cacheStatus?.trim() || '', disabled: await clearCacheButton.isDisabled()};
    if (!cacheBeforeClear.status || !/个视频|读取缓存状态/.test(cacheBeforeClear.status)) fail(`X 字幕缓存状态缺失：${JSON.stringify(cacheBeforeClear)}`);
    if (!cacheBeforeClear.disabled) {
      await clearCacheButton.click();
      await optionsPage.waitForTimeout(250);
      if (!(await cachePanel.locator('[role="status"]').textContent())?.includes('0 个视频')) fail('清除 X 字幕缓存后状态未归零');
    }
    result.persistence.cache = cacheBeforeClear;
    await optionsPage.locator('[data-video-subtitle-preview-scene]').scrollIntoViewIfNeeded();
    await screenshot(optionsPage, path.join(options.artifactsDir, 'options-video-settings.png'));
    result.screenshots.push(path.join(options.artifactsDir, 'options-video-settings.png'));
    await optionsPage.setViewportSize({width: 390, height: 844});
    await optionsPage.waitForTimeout(100);
    await optionsPage.locator('[data-video-subtitle-preview-scene]').scrollIntoViewIfNeeded();
    const mobile = await optionsPage.evaluate(() => ({width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth}));
    result.mobile = mobile;
    if (mobile.scrollWidth > mobile.width + 1) fail(`视频设置窄屏横向溢出：${JSON.stringify(mobile)}`);
    await screenshot(optionsPage, path.join(options.artifactsDir, 'options-video-settings-mobile.png'));
    result.screenshots.push(path.join(options.artifactsDir, 'options-video-settings-mobile.png'));
    await optionsPage.close();

    const reopenedOptions = await openExtensionPage(session.context, optionsUrl, {width: 1440, height: 1000});
    await reopenedOptions.locator('.settings-app').waitFor({state: 'visible', timeout: 30000});
    await selectOptionsVideo(reopenedOptions);
    const afterClose = await reopenedOptions.locator('#settings-video').evaluate(element => ({
      sourceLanguage: element.querySelector('[role="combobox"][aria-label="视频原语言"]')?.closest('.el-select')?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim(),
      skin: element.querySelector('[data-video-subtitle-appearance] [data-skin].selected')?.getAttribute('data-skin'),
      fontScale: element.querySelector('[data-video-subtitle-appearance] input[aria-label="字幕字号"]')?.value,
      enabled: element.querySelector('[aria-label="视频字幕翻译"]')?.getAttribute('aria-checked'),
    }));
    result.persistence.afterReopen = afterClose;
    result.persistence.passed = afterClose.sourceLanguage === '한국어' && afterClose.skin === 'terminal' && afterClose.fontScale === '130' && afterClose.enabled === 'true';
    if (!result.persistence.passed) fail(`配置重开后未保持：${JSON.stringify(result.persistence)}`);
    await reopenedOptions.close();

    const popup = await openExtensionPage(session.context, popupUrl, {width: 400, height: 600});
    await popup.locator('.popup-shell').waitFor({state: 'visible', timeout: 30000});
    const onboarding = popup.locator('[data-testid="ui-language-onboarding"]');
    if (await onboarding.count()) {
      await onboarding.locator('[data-testid="onboarding-language-next"]').click();
      await onboarding.locator('[data-language="zh-CN"]').click();
      await onboarding.locator('.onboarding-confirm').click();
      await onboarding.waitFor({state: 'hidden', timeout: 30000});
    }
    await popup.locator('[data-popup-quick-feature="video"]').click();
    await popup.locator('.drawer-content').waitFor({state: 'visible', timeout: 30000});
    const xGroup = popup.locator('.x-video-ai-group');
    result.popup = {
      xGroup: await xGroup.count(),
      sourceLanguage: await popup.locator('[aria-label="视频原语言"]').count(),
      links: await popup.locator('.video-model-settings-link').count(),
      fontScale: await popup.locator('select[aria-label="视频字幕字号"]').inputValue(),
    };
    if (result.popup.xGroup !== 1 || result.popup.sourceLanguage !== 1 || result.popup.links < 2 || result.popup.fontScale !== '130') fail(`Popup X 设置未保持：${JSON.stringify(result.popup)}`);
    await screenshot(popup, path.join(options.artifactsDir, 'popup-video-settings.png'));
    result.screenshots.push(path.join(options.artifactsDir, 'popup-video-settings.png'));
    await popup.close();
    if (result.consoleErrors.length) fail(`UI 控制台存在错误：${result.consoleErrors.join(' | ')}`);
    result.success = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    throw error;
  } finally {
    if (session) await session.close();
    fs.writeFileSync(path.join(options.artifactsDir, 'report.json'), JSON.stringify(result, null, 2));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
