#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createRuntimeDiagnostics, finalizeRun, redact } = require('./runtime-diagnostics.cjs');
const {browserReport} = require('./report-summary.cjs');
let diagnostics;
const {
  activateExtensionTabWithoutForeground,
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
  resolveBackgroundDisplayTarget,
} = require('./focus-safe-browser.cjs');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    timeout: 60000,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    reportFormat: 'summary',
    keepProfile: false,
    headless: false,
    background: true,
    suite: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--keep-profile') {
      args.keepProfile = true;
      continue;
    }
    if (token === '--headed') {
      args.headless = false;
      args.background = false;
      continue;
    }
    if (token === '--headless') {
      args.headless = true;
      args.background = false;
      continue;
    }
    if (token === '--background') {
      args.headless = false;
      args.background = true;
      continue;
    }
    if (!token.startsWith('--')) fail(`无法识别的参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`参数缺少值：${token}`);
    args[key] = value;
    index += 1;
  }
  if (!['summary', 'json'].includes(args.reportFormat)) fail('--report-format 只能使用 summary 或 json');
  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) fail('--timeout 必须是正数');
  const allowedSuites = new Set(['full', 'popup', 'options', 'services', 'responsive', 'isolation', 'persistence']);
  args.suites = String(args.suite)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (!args.suites.length || args.suites.some(value => !allowedSuites.has(value))) {
    fail(`--suite 只能使用：${[...allowedSuites].join('、')}；也可以用逗号组合多个专项`);
  }
  return args;
}

function loadPlaywright(playwrightRoot) {
  try {
    return require('playwright');
  } catch (localError) {
    if (!playwrightRoot) fail(`无法加载 Playwright：${localError.message}`);
    const root = path.resolve(playwrightRoot);
    if (!fs.existsSync(root)) fail(`Playwright 依赖目录不存在：${root}`);
    const requireFromRuntime = createRequire(path.join(root, '__fluentread_ui_skill_loader__.cjs'));
    return requireFromRuntime('playwright');
  }
}

// 拒绝误把日常浏览器 profile 传给自动化，避免复用用户当前页面和登录状态。
function assertDedicatedProfile(profileDir, suppliedProfile) {
  if (!suppliedProfile) return;
  const resolvedProfile = path.resolve(profileDir);
  const home = os.homedir();
  const forbiddenRoots = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
    path.join(home, 'AppData/Local/Google/Chrome/User Data'),
    path.join(home, 'AppData/Local/Microsoft/Edge/User Data'),
  ];
  const isInside = root => {
    const relative = path.relative(root, resolvedProfile);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (forbiddenRoots.some(isInside)) {
    fail(`拒绝使用日常浏览器 profile：${resolvedProfile}。请改用 /private/tmp 或其他专用临时目录。`);
  }
}

function extensionPage(manifest, type) {
  if (type === 'popup') return manifest.action?.default_popup || manifest.browser_action?.default_popup;
  return manifest.options_ui?.page || manifest.options_page;
}

async function capturePageErrors(page, label) {
  await diagnostics.attachPage(page, label);
}

function recordCase(result, id, details = {}) {
  result.caseCoverage.push({ id, status: 'passed', ...details });
}

function consumeExpectedErrors(checkpoint, caseId, surface, exactMessages) {
  diagnostics.expectSince(checkpoint, { caseId, surface, exactMessages, level: 'error', maxCount: 1 });
}

async function clickWithoutActivating(page, selector) {
  await page.evaluate(selector => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`找不到待点击控件：${selector}`);
    element.click();
  }, selector);
}

async function clickVisibleElementPlusOption(page, label) {
  const option = page.locator('[role="option"]:visible').filter({ hasText: label }).first();
  await option.waitFor({ state: 'visible' });
  await option.evaluate(element => element.click());
}

async function selectDefaultTargetLanguage(page, languageCombobox, label, timeout) {
  await languageCombobox.click({ force: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="默认目标语言"]')?.getAttribute('aria-expanded') === 'true', { timeout });
  await clickVisibleElementPlusOption(page, label);
  await page.waitForFunction(expected => {
    const input = document.querySelector('[aria-label="默认目标语言"]');
    return input?.parentElement?.parentElement?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() === expected;
  }, label, { timeout });
}

async function waitForWorker(context, timeout, errors, label = 'service-worker') {
  let workers = context.serviceWorkers();
  if (workers.length === 0) workers = [await context.waitForEvent('serviceworker', { timeout })];
  const worker = workers[0];
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) fail(`无法从 Service Worker URL 获取扩展 ID：${worker.url()}`);
  return { worker, extensionId: match[1] };
}

async function injectDevContentScript(worker, manifest, extensionDir, page) {
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0) return 'manifest';
  const scriptPath = 'content-scripts/content.js';
  if (!fs.existsSync(path.join(extensionDir, scriptPath))) {
    fail(`开发构建缺少内容脚本：${scriptPath}`);
  }
  await page.waitForTimeout(500);
  if (await page.locator('#fluent-read-page-styles').count()) return 'wxt-dev-registration';

  const pageUrl = page.url();
  await worker.evaluate(async ({ url, js }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(candidate => candidate.url === url);
    if (!tab?.id) throw new Error(`找不到 CSS 隔离测试标签页：${url}`);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [js],
    });
  }, { url: pageUrl, js: scriptPath });
  return 'chrome.scripting.executeScript';
}

async function openExtensionPage(context, url, viewport, label, errors, timeout, colorScheme) {
  const page = await newPageWithoutForeground(context, Math.min(timeout, 10000));
  await capturePageErrors(page, label);
  await page.setViewportSize(viewport);
  if (colorScheme) await page.emulateMedia({ colorScheme });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  return page;
}

async function openPopupMessageTarget(context, url, viewport, label, errors, timeout) {
  const page = await newPageWithoutForeground(context, Math.min(timeout, 10000));
  await capturePageErrors(page, label);
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'contextMenuTranslate' && message?.message !== 'clearCache') return false;
      const mode = document.documentElement?.dataset.fluentreadPopupMode || 'success';
      const delay = Number(document.documentElement?.dataset.fluentreadPopupDelay || 0);
      window.setTimeout(() => sendResponse({ status: mode === 'disabled' && message?.type === 'contextMenuTranslate' ? 'disabled' : 'success' }), delay);
      return true;
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  return page;
}

async function screenshot(page, artifactsDir, fileName, result) {
  const screenshotPath = path.join(artifactsDir, fileName);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  result.screenshots.push(screenshotPath);
}

async function auditDom(page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id).filter(Boolean);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const isVisible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const unnamedInteractive = [...document.querySelectorAll('button, input, select, textarea, a[href]')]
      .filter(isVisible)
      .filter(element => {
        const labelledBy = element.getAttribute('aria-labelledby');
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')
          : '';
        const labels = 'labels' in element && element.labels
          ? [...element.labels].map(label => label.textContent || '').join(' ')
          : '';
        const name = [
          element.getAttribute('aria-label'),
          labelledText,
          element.getAttribute('title'),
          element.getAttribute('alt'),
          labels,
          element.textContent,
          element.getAttribute('placeholder'),
        ].filter(Boolean).join(' ').trim();
        return !name;
      })
      .map(element => element.outerHTML.slice(0, 180));
    return { duplicateIds, unnamedInteractive };
  });
}

async function popupMetrics(page) {
  return page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    overflowingElements: [...document.querySelectorAll('*')]
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))
      .slice(0, 8)
      .map(element => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
  }));
}

async function waitForOptionsPage(context, optionsUrl, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = context.pages().find(candidate => candidate.url().startsWith(optionsUrl));
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail(`点击完整设置后没有打开 options 页面；当前页面：${context.pages().map(page => page.url()).join(', ')}`);
}

async function runPersistenceSuite(context, popupUrl, optionsUrl, artifactsDir, result, errors, timeout) {
  const persistence = {
    before: 'zh-Hans',
    after: null,
    quickClose: true,
    crossPageSync: false,
    latestWriteWins: false,
  };
  const options = await openExtensionPage(context, optionsUrl, { width: 1440, height: 1000 }, 'persistence-options', errors, timeout, 'light');
  await options.locator('.settings-app').waitFor({ state: 'visible', timeout });
  const languageCombobox = options.getByRole('combobox', { name: '默认目标语言' });
  await selectDefaultTargetLanguage(options, languageCombobox, '英语', timeout);
  // 连续修改后立即关闭，验证最新快照胜出且 pagehide 仍能把请求交给后台。
  await selectDefaultTargetLanguage(options, languageCombobox, '日语', timeout);
  // 等待 Vue 的同步 watcher 把最后一次选择送入 runtime，再执行短生命周期关闭。
  await options.waitForTimeout(80);
  const selectedLanguageLabel = await languageCombobox.evaluate(element => element.parentElement?.parentElement?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim());
  const workerBeforeClose = context.serviceWorkers()[0];
  const storedBeforeClose = workerBeforeClose
    ? await workerBeforeClose.evaluate(async () => {
      const value = (await chrome.storage.local.get(null)).config;
      return { to: value?.to, revision: value?.__fluentConfigRevision };
    })
    : null;
  await options.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  const worker = context.serviceWorkers()[0];
  const storedAfterClose = worker
    ? await worker.evaluate(async () => {
      const value = (await chrome.storage.local.get(null)).config;
      return { to: value?.to, revision: value?.__fluentConfigRevision };
    })
    : null;

  const popup = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, 'persistence-popup-reopen', errors, timeout, 'light');
  await popup.locator('.popup-shell').waitFor({ state: 'visible', timeout });
  const targetSelect = popup.locator('.language-pair select').nth(1);
  await targetSelect.waitFor({ state: 'visible', timeout });
  persistence.after = await targetSelect.inputValue();
  persistence.storage = await popup.evaluate(async () => {
    const value = (await chrome.storage.local.get(null)).config;
    return { to: value?.to, revision: value?.__fluentConfigRevision };
  });
  persistence.crossPageSync = persistence.after === 'ja';
  persistence.latestWriteWins = persistence.crossPageSync;
  await screenshot(popup, artifactsDir, 'persistence-popup-reopen.png', result);
  await popup.close();
  result.persistenceCases = persistence;
  result.persistenceOptionsLabel = selectedLanguageLabel;
  result.persistenceStorageBeforeClose = storedBeforeClose;
  result.persistenceStorageAfterClose = storedAfterClose;
  if (!persistence.crossPageSync) {
    fail(`配置快速关闭后未跨页面保持最新值：${JSON.stringify({ persistence, selectedLanguageLabel, storedBeforeClose, storedAfterClose })}`);
  }
  recordCase(result, 'persistence.options-quick-close-cross-page', persistence);

  // 配置历史：通过真实 options 控件生成多个版本，确认最多保留 5 条，
  // 并验证恢复、撤销、重做都能回到同一份配置与历史游标。
  const historyOptions = await openExtensionPage(context, optionsUrl, { width: 1440, height: 1000 }, 'persistence-config-history', errors, timeout, 'light');
  await historyOptions.locator('.settings-app').waitFor({ state: 'visible', timeout });
  const historySection = historyOptions.locator('#settings-data');
  await historyOptions.getByRole('button', { name: '配置管理' }).click();
  await historySection.waitFor({ state: 'visible', timeout });
  const historyPanel = historyOptions.locator('.config-history-panel');
  await historyPanel.waitFor({ state: 'visible', timeout });
  const historyEntries = historyPanel.locator('.config-history-entry');
  const historyBefore = await historyEntries.count();
  if (historyBefore < 1 || historyBefore > 5) fail(`配置历史条目数量应在 1-5 之间，实际为 ${historyBefore}`);
  const historyVersions = await historyEntries.locator('.config-history-version b').allTextContents();
  if (historyVersions.some(text => !/^v\d+$/.test(text.trim()))) fail(`配置历史版本号格式错误：${historyVersions.join(', ')}`);
  if (await historyPanel.locator('.config-history-detail small').count() !== historyBefore) fail('配置历史缺少时间展示');
  recordCase(result, 'persistence.config-history.max-five-and-timestamps', { count: historyBefore, versions: historyVersions });

  await historyOptions.getByRole('button', { name: '通用设置' }).click();
  await selectDefaultTargetLanguage(historyOptions, historyOptions.getByRole('combobox', { name: '默认目标语言' }), '英语', timeout);
  await historyOptions.waitForTimeout(500);
  await selectDefaultTargetLanguage(historyOptions, historyOptions.getByRole('combobox', { name: '默认目标语言' }), '日语', timeout);
  await historyOptions.waitForTimeout(500);
  await historyOptions.getByRole('button', { name: '配置管理' }).click();
  await historyPanel.waitFor({ state: 'visible', timeout });
  const restoreButtons = historyPanel.locator('button[aria-label^="恢复配置 v"]:not([disabled])');
  const restoreCount = await restoreButtons.count();
  if (restoreCount < 1) fail('配置历史没有可用恢复按钮');
  const currentVersion = await historyPanel.locator('.config-history-entry.current .config-history-version b').textContent();
  const restoreTarget = restoreButtons.first();
  await restoreTarget.click();
  await historyOptions.waitForTimeout(450);
  const restoredCurrent = await historyPanel.locator('.config-history-entry.current .config-history-version b').textContent();
  if (!restoredCurrent || restoredCurrent === currentVersion) fail('点击配置历史恢复后当前版本没有变化');
  recordCase(result, 'persistence.config-history.restore', { before: currentVersion, after: restoredCurrent });

  const undoButton = historyPanel.getByRole('button', { name: '撤销配置恢复' });
  const redoButton = historyPanel.getByRole('button', { name: '重做配置恢复' });
  if (await undoButton.isDisabled()) fail('配置历史恢复后撤销按钮仍不可用');
  await undoButton.click();
  await historyOptions.waitForTimeout(450);
  const undoneVersion = await historyPanel.locator('.config-history-entry.current .config-history-version b').textContent();
  if (undoneVersion === restoredCurrent) fail('配置历史撤销没有移动当前版本');
  if (await redoButton.isDisabled()) fail('配置历史撤销后重做按钮不可用');
  await redoButton.click();
  await historyOptions.waitForTimeout(450);
  const redoneVersion = await historyPanel.locator('.config-history-entry.current .config-history-version b').textContent();
  if (redoneVersion !== restoredCurrent) fail('配置历史重做没有回到恢复版本');
  recordCase(result, 'persistence.config-history.undo-redo', { restored: restoredCurrent, undone: undoneVersion, redone: redoneVersion });
  await screenshot(historyOptions, artifactsDir, 'persistence-config-history.png', result);
  await historyOptions.setViewportSize({ width: 390, height: 844 });
  await historyOptions.waitForTimeout(120);
  const historyMobileMetrics = await historyOptions.locator('.settings-app').evaluate(element => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    panelWidth: element.querySelector('.config-history-panel')?.getBoundingClientRect().width || 0,
  }));
  if (historyMobileMetrics.horizontalOverflow) fail(`配置历史窄屏出现横向溢出：${JSON.stringify(historyMobileMetrics)}`);
  recordCase(result, 'persistence.config-history.mobile-layout', historyMobileMetrics);
  await screenshot(historyOptions, artifactsDir, 'persistence-config-history-mobile.png', result);
  await historyOptions.close();
}

async function startHostileCssServer() {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>FluentRead CSS 隔离测试</title>
    <style>
      html, body, * {
        box-sizing: content-box !important;
        color: rgb(1, 2, 3) !important;
        font-family: "Times New Roman", serif !important;
      }
      button, div, span, svg {
        position: static !important;
        width: 100% !important;
        height: 120px !important;
        margin: 27px !important;
        padding: 31px !important;
        border: 13px solid rgb(0, 255, 0) !important;
        border-radius: 0 !important;
        background: rgb(255, 255, 0) !important;
        font-size: 42px !important;
      }
    </style>
  </head>
  <body>
    <h1>宿主页面强制 CSS</h1>
    <button id="hostile-control">宿主按钮</button>
    <p id="selection-source">Select this English sentence to verify that FluentRead widgets stay isolated.</p>
  </body>
</html>`;

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('无法启动 CSS 隔离测试服务器');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.extensionDir) fail('必须传入 --extension-dir');
  const extensionDir = path.resolve(args.extensionDir);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`找不到扩展清单：${manifestPath}`);
  if (!fs.existsSync(args.browserPath)) fail(`找不到浏览器：${args.browserPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const popupPath = extensionPage(manifest, 'popup');
  const optionsPath = extensionPage(manifest, 'options');
  if (!popupPath) fail('清单缺少 action.default_popup');
  if (!optionsPath) fail('清单缺少 options_page 或 options_ui.page');
  if (!fs.existsSync(path.join(extensionDir, popupPath))) fail(`popup 文件不存在：${popupPath}`);
  if (!fs.existsSync(path.join(extensionDir, optionsPath))) fail(`options 文件不存在：${optionsPath}`);

  const artifactsDir = path.resolve(args.artifactsDir || path.join(os.tmpdir(), 'fluentread-ui-evidence'));
  fs.mkdirSync(artifactsDir, { recursive: true });
  const requestedDisplay = args.display ?? args.displayIndex ?? 'secondary';
  const displayTarget = args.background && !args.headless ? resolveBackgroundDisplayTarget(requestedDisplay) : requestedDisplay;
  const suppliedProfile = Boolean(args.profileDir);
  const profileDir = suppliedProfile
    ? path.resolve(args.profileDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ui-edge-profile-'));
  if (suppliedProfile) fs.mkdirSync(profileDir, { recursive: true });
  assertDedicatedProfile(profileDir, suppliedProfile);
  const crashDumpsDir = path.join(profileDir, 'crash-dumps');
  fs.mkdirSync(crashDumpsDir, { recursive: true });

  const { chromium } = loadPlaywright(args.playwrightRoot);
  const result = {
    ok: false,
    browser: 'Microsoft Edge',
    extensionDir,
    profileDir,
    popupPath,
    optionsPath,
    windowMode: args.headless ? 'headless' : args.background ? 'background-visible-no-focus' : 'headed-centered',
    displayTarget,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    assertions: {},
    caseCoverage: [],
    screenshots: [],
    artifactsDir,
    errors: [],
    warnings: [],
  };
  const wants = suite => args.suites.includes('full') || args.suites.includes(suite);
  const runOptions = wants('options') || wants('services') || wants('responsive') || wants('isolation');
  let context;
  let browserSession;
  let browserClosed = false;
  let hostileCssServer;
  let popupDark;
  let options;
  let caughtError;
  diagnostics = createRuntimeDiagnostics();

  try {
    browserSession = await launchFocusSafePersistentContext({
      chromium,
      profileDir,
      browserPath: args.browserPath,
      headless: args.headless,
      background: args.background,
      displayTarget,
      browserArgs: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        `--crash-dumps-dir=${crashDumpsDir}`,
        '--disable-crash-reporter',
        ...(!args.background && !args.headless ? ['--window-size=1280,900', '--window-position=0,0'] : []),
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: { width: 1280, height: 900 },
      timeout: Math.min(args.timeout, 30000),
    });
    context = browserSession.context;
    await diagnostics.start(context);
    result.launchMode = browserSession.launchMode;
    result.focusPolicy = browserSession.focusPolicy;
    result.windowPlacement = browserSession.windowPlacement;

    const { worker, extensionId } = await waitForWorker(context, Math.min(args.timeout, 30000), result.errors);
    result.extensionId = extensionId;
    diagnostics.setExtensionId(extensionId);
    const popupUrl = `chrome-extension://${extensionId}/${popupPath}`;
    const optionsUrl = `chrome-extension://${extensionId}/${optionsPath}`;

    diagnostics.setPhase(`ui-suites:${args.suites.join(',')}`);
    const popup = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, 'popup', result.errors, args.timeout, 'light');
    await popup.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
    await popup.getByRole('heading', { name: /让阅读自然地流动|翻译功能已暂停/ }).waitFor();
    await popup.waitForTimeout(350);

    const popupTarget = await openPopupMessageTarget(
      context,
      popupUrl,
      { width: 1000, height: 700 },
      'popup-message-target',
      result.errors,
      args.timeout,
    );
    result.popupTargetId = popupTarget.url();

    if (wants('persistence')) {
      await runPersistenceSuite(context, popupUrl, optionsUrl, artifactsDir, result, result.errors, args.timeout);
    }

    if (wants('popup')) {
    const metrics = await popupMetrics(popup);
    result.popupMetrics = metrics;
    if (metrics.width > 400) fail(`popup 宽度超过 400px：${metrics.width}`);
    if (metrics.height > 600) fail(`popup 高度超过 600px：${metrics.height}`);
    if (metrics.horizontalOverflow) fail('popup 出现横向滚动');
    if (await popup.locator('.feature-card').count() !== 6) fail('popup 快捷功能卡数量不是 6');
    if (await popup.locator('.language-pair select').count() !== 2) fail('popup 源语言/目标语言选择器不完整');
    const servicePickerButton = popup.locator('.service-field');
    if (await servicePickerButton.count() !== 1) fail('popup 翻译服务选择器缺失');
    if (await servicePickerButton.getAttribute('aria-haspopup') !== 'listbox') fail('popup 翻译服务选择器缺少 listbox 语义');
    const popupAudit = await auditDom(popup);
    if (popupAudit.duplicateIds.length) fail(`popup 存在重复 ID：${popupAudit.duplicateIds.join(', ')}`);
    if (popupAudit.unnamedInteractive.length) fail(`popup 存在无可访问名称控件：${popupAudit.unnamedInteractive[0]}`);
    result.popupAudit = popupAudit;
    const openSourceLink = popup.locator('.opensource-link');
    if (await openSourceLink.count() !== 1) fail('popup 缺少居中的开源项目入口');
    if (await openSourceLink.getAttribute('href') !== 'https://github.com/Bistutu/FluentRead') fail('popup 开源项目入口地址不正确');
    if (await openSourceLink.getAttribute('target') !== '_blank') fail('popup 开源项目入口没有使用新标签页打开');
    if (await openSourceLink.locator('svg').count() !== 1) fail('popup 开源项目入口缺少本地图标');
    const popupFooter = popup.locator('footer');
    const footerStats = popupFooter.locator(':scope > span');
    const footerClear = popupFooter.locator(':scope > button');
    if (await footerStats.count() !== 1 || await footerClear.count() !== 1) fail('popup 底部统计、开源入口和清缓存操作结构不完整');
    const [footerBox, statsBox, linkBox, clearBox] = await Promise.all([
      popupFooter.boundingBox(),
      footerStats.boundingBox(),
      openSourceLink.boundingBox(),
      footerClear.boundingBox(),
    ]);
    if (!footerBox || !statsBox || !linkBox || !clearBox) fail('popup 底部三项缺少可见布局尺寸');
    const footerCenters = [statsBox.y + statsBox.height / 2, linkBox.y + linkBox.height / 2, clearBox.y + clearBox.height / 2];
    if (Math.max(...footerCenters) - Math.min(...footerCenters) > 4) fail('popup 底部三项没有处于同一行');
    const footerCenter = footerBox.x + footerBox.width / 2;
    const linkCenter = linkBox.x + linkBox.width / 2;
    if (Math.abs(footerCenter - linkCenter) > 4) fail('popup 开源项目入口没有在底部居中');
    result.assertions.popupCore = true;
    recordCase(result, 'popup.layout.light');
    recordCase(result, 'popup.accessibility.core');
    recordCase(result, 'popup.opensource.github-link', { href: await openSourceLink.getAttribute('href') });
    await screenshot(popup, artifactsDir, 'popup-light.png', result);

    const sourceSelect = popup.locator('.language-pair select').nth(0);
    const targetSelect = popup.locator('.language-pair select').nth(1);
    if (await sourceSelect.locator('option').count() !== 1) fail('源语言选项不符合自动检测单选预期');
    await sourceSelect.selectOption('auto');
    recordCase(result, 'popup.language.source.auto');
    for (const option of await targetSelect.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, label: element.textContent?.trim() || '' })))) {
      await targetSelect.selectOption(option.value);
      if (await targetSelect.inputValue() !== option.value) fail(`目标语言未能选择：${option.label}`);
      recordCase(result, `popup.language.target.${option.value}`, { label: option.label });
    }
    await servicePickerButton.click();
    const servicePanel = popup.locator('.service-picker-panel');
    await servicePanel.waitFor({ state: 'visible', timeout: args.timeout });
    const popularServiceOptions = servicePanel.locator('.service-group:not(.service-group-more) .service-option');
    if (await popularServiceOptions.count() < 6) fail('popup 常用翻译服务数量过少');
    const popularServiceIcons = popularServiceOptions.locator('.service-brand-icon');
    if (await popularServiceIcons.count() !== await popularServiceOptions.count()) fail('popup 常用翻译服务图标数量不完整');
    if (await popularServiceIcons.locator('svg').count() !== await popularServiceOptions.count()) fail('popup 常用翻译服务存在未渲染的本地图标');
    const moreServicesToggle = servicePanel.getByRole('button', { name: /更多服务/ });
    if (await moreServicesToggle.count() !== 1) fail('popup 缺少“更多服务”折叠入口');
    if (await moreServicesToggle.getAttribute('aria-expanded') !== 'false') fail('popup 更多服务默认没有收起');
    recordCase(result, 'popup.service-picker.popular-visible', {
      count: await popularServiceOptions.count(),
      labels: await popularServiceOptions.locator('span:nth-child(2)').allTextContents(),
    });
    await screenshot(popup, artifactsDir, 'popup-service-picker.png', result);

    const popularServices = await popularServiceOptions.evaluateAll(elements => elements.map(element => ({
      value: element.getAttribute('data-service-value') || '',
      label: element.querySelector('span:nth-child(2)')?.textContent?.trim() || '',
    }))); 
    for (const option of popularServices) {
      await clickWithoutActivating(popup, `.service-picker-panel .service-option[data-service-value="${option.value}"]`);
      try {
        await popup.waitForFunction(label => document.querySelector('.service-field strong')?.textContent?.trim() === label, option.label, { timeout: args.timeout });
      } catch {
        fail(`常用翻译服务未能选择：${option.label}（当前：${await servicePickerButton.locator('strong').textContent()}）`);
      }
      recordCase(result, `popup.service.${option.value}`, { label: option.label, group: 'popular' });
      await servicePickerButton.click({ force: true });
      await servicePanel.waitFor({ state: 'visible', timeout: args.timeout });
    }

    if (await moreServicesToggle.getAttribute('aria-expanded') !== 'false') fail('常用服务选择后更多服务意外展开');
    await moreServicesToggle.click({ force: true });
    await moreServicesToggle.waitFor({ state: 'visible', timeout: args.timeout });
    if (await moreServicesToggle.getAttribute('aria-expanded') !== 'true') fail('popup 更多服务无法展开');
    const moreServiceOptions = servicePanel.locator('.service-group-more .service-option');
    if (await moreServiceOptions.count() < 10) fail('popup 更多服务列表数量异常');
    const moreServiceIcons = moreServiceOptions.locator('.service-brand-icon');
    if (await moreServiceIcons.count() !== await moreServiceOptions.count()) fail('popup 更多服务图标数量不完整');
    if (await moreServiceIcons.locator('svg').count() !== await moreServiceOptions.count()) fail('popup 更多服务存在未渲染的本地图标');
    recordCase(result, 'popup.service-picker.more-expanded', { count: await moreServiceOptions.count() });
    const allMoreServices = await moreServiceOptions.evaluateAll(elements => elements.map(element => ({
      value: element.getAttribute('data-service-value') || '',
      label: element.querySelector('span:nth-child(2)')?.textContent?.trim() || '',
    }))); 
    for (const option of allMoreServices) {
      if (await moreServicesToggle.getAttribute('aria-expanded') !== 'true') {
        await moreServicesToggle.click({ force: true });
      }
      await clickWithoutActivating(popup, `.service-picker-panel .service-option[data-service-value="${option.value}"]`);
      try {
        await popup.waitForFunction(label => document.querySelector('.service-field strong')?.textContent?.trim() === label, option.label, { timeout: args.timeout });
      } catch {
        fail(`更多翻译服务未能选择：${option.label}（当前：${await servicePickerButton.locator('strong').textContent()}）`);
      }
      recordCase(result, `popup.service.${option.value}`, { label: option.label, group: 'more' });
      await servicePickerButton.click({ force: true });
      await servicePanel.waitFor({ state: 'visible', timeout: args.timeout });
    }
    if (await moreServicesToggle.getAttribute('aria-expanded') !== 'true') fail('选择更多服务后当前服务没有保持可见');
    await moreServicesToggle.click({ force: true });
    if (await moreServicesToggle.getAttribute('aria-expanded') !== 'false') fail('popup 更多服务无法收起');
    await popup.keyboard.press('Escape');
    if (await servicePanel.isVisible()) fail('popup 服务面板无法通过 Escape 关闭');
    await servicePickerButton.click({ force: true });
    await servicePanel.waitFor({ state: 'visible', timeout: args.timeout });
    await popup.locator('.popup-shell').click({ position: { x: 4, y: 4 } });
    if (await servicePanel.isVisible()) fail('popup 服务面板无法通过点击外部关闭');
    await servicePickerButton.click({ force: true });
    await servicePanel.waitFor({ state: 'visible', timeout: args.timeout });
    await clickWithoutActivating(popup, '.service-picker-panel .service-option[data-service-value="microsoft"]');

    const translateButton = popup.locator('.translate-button');
    await popupTarget.evaluate(() => {
      document.documentElement.dataset.fluentreadPopupMode = 'success';
      document.documentElement.dataset.fluentreadPopupDelay = '350';
    });
    await activateExtensionTabWithoutForeground(context, popupTarget, Math.min(args.timeout, 10000));
    await clickWithoutActivating(popup, '.translate-button');
    if (!await translateButton.isDisabled()) fail('全文翻译加载期间按钮没有禁用');
    if (!await translateButton.locator('.spinner').isVisible()) fail(`全文翻译加载期间缺少 spinner：${JSON.stringify({ text: await translateButton.innerText(), html: await translateButton.innerHTML() })}`);
    recordCase(result, 'popup.translation.loading');
    await popup.getByText('正在翻译当前网页', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    if (!(await translateButton.innerText()).includes('恢复当前网页')) fail(`全文翻译成功后没有切换为恢复按钮：${await translateButton.innerText()}`);
    if (!await translateButton.evaluate(element => element.classList.contains('translated'))) fail('全文翻译成功后按钮没有进入已翻译视觉状态');
    recordCase(result, 'popup.translation.success');

    await popupTarget.evaluate(() => { document.documentElement.dataset.fluentreadPopupDelay = '0'; });
    await activateExtensionTabWithoutForeground(context, popupTarget, Math.min(args.timeout, 10000));
    await clickWithoutActivating(popup, '.translate-button');
    await popup.getByText('已恢复网页原文', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    if (!(await translateButton.innerText()).includes('翻译当前网页')) fail('恢复网页成功后没有切换回翻译按钮');
    if (await translateButton.evaluate(element => element.classList.contains('translated'))) fail('恢复网页成功后按钮仍保留已翻译视觉状态');
    recordCase(result, 'popup.translation.restore');

    await popupTarget.evaluate(() => { document.documentElement.dataset.fluentreadPopupMode = 'disabled'; });
    await activateExtensionTabWithoutForeground(context, popupTarget, Math.min(args.timeout, 10000));
    diagnostics.setPhase('popup.translation.disabled-response');
    const disabledCheckpoint = diagnostics.checkpoint();
    await clickWithoutActivating(popup, '.translate-button');
    await popup.getByText('当前页面暂不支持翻译，请刷新后重试', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    if (await translateButton.evaluate(element => element.classList.contains('translated'))) fail('翻译失败后按钮错误进入已翻译视觉状态');
    consumeExpectedErrors(disabledCheckpoint, 'popup.translation.disabled-response', 'popup', ['Error: Plugin disabled']);
    recordCase(result, 'popup.translation.disabled-response');

    await activateExtensionTabWithoutForeground(context, popup, Math.min(args.timeout, 10000));
    diagnostics.setPhase('popup.translation.no-active-content-script');
    const noContentCheckpoint = diagnostics.checkpoint();
    await clickWithoutActivating(popup, '.translate-button');
    await popup.getByText('当前页面暂不支持翻译，请刷新后重试', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    consumeExpectedErrors(noContentCheckpoint, 'popup.translation.no-active-content-script', 'popup', ['Error: No receiving end', 'Error: Could not establish connection. Receiving end does not exist.', 'Error: No active tab', 'Error: Plugin disabled']);
    recordCase(result, 'popup.translation.no-active-content-script');

    await popupTarget.evaluate(() => {
      document.documentElement.dataset.fluentreadPopupMode = 'success';
      document.documentElement.dataset.fluentreadPopupDelay = '350';
    });
    const cachePopup = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, 'popup-cache-cases', result.errors, args.timeout, 'light');
    await cachePopup.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
    await cachePopup.waitForTimeout(350);
    await activateExtensionTabWithoutForeground(context, popupTarget, Math.min(args.timeout, 10000));
    const clearCacheButton = cachePopup.locator('footer button');
    await clickWithoutActivating(cachePopup, 'footer button');
    await clearCacheButton.getByText('清理中…').waitFor({ state: 'visible', timeout: 2000 });
    if (!await clearCacheButton.isDisabled()) fail('清理缓存加载期间按钮没有禁用');
    recordCase(result, 'popup.cache.loading');
    await cachePopup.getByText('全部翻译缓存已清除', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    recordCase(result, 'popup.cache.success');
    await activateExtensionTabWithoutForeground(context, cachePopup, Math.min(args.timeout, 10000));
    diagnostics.setPhase('popup.cache.error');
    const cacheErrorCheckpoint = diagnostics.checkpoint();
    await clearCacheButton.click();
    await cachePopup.getByText('缓存清除失败', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    consumeExpectedErrors(cacheErrorCheckpoint, 'popup.cache.error', 'popup-cache-cases', ['Error: No receiving end', 'Error: Could not establish connection. Receiving end does not exist.', 'Error: No active tab']);
    recordCase(result, 'popup.cache.error');
    await cachePopup.close();

    const pluginSwitch = popup.getByRole('switch', { name: /暂停插件|启用插件/ });
    if (await pluginSwitch.getAttribute('aria-checked') !== 'true') fail('新配置中的插件默认未启用');
    await clickWithoutActivating(popup, '.hero-heading button[role="switch"]');
    await popup.waitForFunction(() => document.querySelectorAll('.feature-card:disabled').length === 6, null, { timeout: args.timeout });
    if (!await popup.locator('.translate-button').isDisabled()) fail('暂停插件后全文翻译按钮仍可点击');
    await clickWithoutActivating(popup, '.hero-heading button[role="switch"]');
    try {
      await popup.waitForFunction(() => document.querySelectorAll('.feature-card:disabled').length === 0, null, { timeout: args.timeout });
    } catch {
      const state = await popup.evaluate(() => ({ heading: document.querySelector('.hero-heading button[role="switch"]')?.getAttribute('aria-checked'), cards: document.querySelectorAll('.feature-card:disabled').length }));
      const stored = await worker.evaluate(async () => chrome.storage.local.get('local:config'));
      fail(`重新启用插件后快捷功能仍处于禁用态：${JSON.stringify({state, persistedOn: stored?.['local:config']?.on})}`);
    }
    result.assertions.pluginSwitch = true;
    recordCase(result, 'popup.plugin.enabled-disabled-enabled');

    await popup.keyboard.press('Tab');
    if (await popup.evaluate(() => document.activeElement === document.body)) fail('popup 键盘 Tab 无法进入交互控件');
    result.assertions.keyboardFocus = true;

    const drawers = [
      { index: 0, title: '悬停翻译设置', file: 'drawer-hover.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        const toggle = panel.getByRole('switch', { name: '启用或关闭鼠标悬停翻译' });
        await toggle.click({ force: true });
        await page.waitForFunction(() => document.querySelector('.popup-drawer button[role="switch"]')?.getAttribute('aria-checked') === 'false', null, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.hover.disabled');
        await toggle.click({ force: true });
        await page.waitForFunction(() => document.querySelector('.popup-drawer button[role="switch"]')?.getAttribute('aria-checked') === 'true', null, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.hover.enabled');
        for (const choice of ['Ctrl', 'Alt / Option', 'Shift']) {
          const button = panel.getByRole('button', { name: choice, exact: true });
          await button.click({ force: true });
          await page.waitForFunction(target => [...document.querySelectorAll('.popup-drawer .chips button')]
            .some(element => element.textContent?.trim() === target && element.classList.contains('selected')), choice, { timeout: args.timeout });
          recordCase(result, `popup.drawer.hover.hotkey.${choice.replaceAll(' ', '-').replaceAll('/', '-')}`);
        }
        await panel.getByRole('button', { name: '自定义', exact: true }).click({ force: true });
        const dialog = page.getByRole('dialog', { name: '自定义快捷键' });
        await dialog.waitFor({ state: 'visible', timeout: args.timeout });
        await dialog.getByRole('button', { name: 'Alt+Q', exact: true }).click();
        await dialog.getByRole('button', { name: '确认', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: args.timeout });
        const currentHotkeyButton = panel.getByRole('button', { name: '当前：Alt+Q', exact: true });
        try {
          await currentHotkeyButton.waitFor({ state: 'visible', timeout: args.timeout });
        } catch {
          const state = await panel.evaluate(element => ({ text: element.textContent, html: element.innerHTML.slice(0, 4000) }));
          fail(`悬停自定义快捷键确认后未显示：${JSON.stringify(state)}`);
        }
        recordCase(result, 'popup.drawer.hover.custom.confirm');
        await currentHotkeyButton.evaluate(button => button.click());
        const reopenedDialog = page.getByRole('dialog', { name: '自定义快捷键' });
        await reopenedDialog.waitFor({ state: 'visible', timeout: args.timeout });
        await reopenedDialog.getByRole('button', { name: '取消', exact: true }).click();
        recordCase(result, 'popup.drawer.hover.custom.cancel');
      } },
      { index: 1, title: '划词翻译设置', file: 'drawer-selection.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        const textToggle = panel.getByRole('switch', { name: '启用或关闭划词翻译' });
        if (await textToggle.getAttribute('aria-checked') === 'true') {
          await textToggle.click({ force: true });
        }
        await page.waitForFunction(() => document.querySelector('.popup-drawer button[aria-label="启用或关闭划词翻译"]')?.getAttribute('aria-checked') === 'false', null, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.selection.disabled');
        await textToggle.click({ force: true });
        await page.waitForFunction(() => document.querySelector('.popup-drawer button[aria-label="启用或关闭划词翻译"]')?.getAttribute('aria-checked') === 'true', null, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.selection.enabled');
        for (const choice of ['双语显示', '仅译文']) {
          const button = panel.locator('.chips button').filter({ hasText: choice }).first();
          await button.click({ force: true });
          await page.waitForFunction(target => [...document.querySelectorAll('.popup-drawer .chips button')]
            .some(element => element.textContent?.trim() === target && element.classList.contains('selected')), choice, { timeout: args.timeout });
          recordCase(result, `popup.drawer.selection.${choice}`);
        }
        for (const trigger of ['直接弹出', '显示图标', '显示小点']) {
          await panel.getByRole('button', { name: trigger, exact: true }).click({ force: true });
          await page.waitForFunction(target => [...document.querySelectorAll('.popup-drawer .chips button')]
            .some(element => element.textContent?.trim() === target && element.classList.contains('selected')), trigger, { timeout: args.timeout });
          recordCase(result, `popup.drawer.selection.trigger.${trigger}`);
        }
        await panel.getByRole('tab', { name: '圈选翻译', exact: true }).click({ force: true });
        const areaToggle = panel.getByRole('switch', { name: '启用或关闭圈选翻译' });
        const initialAreaState = await areaToggle.getAttribute('aria-checked');
        await areaToggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭圈选翻译"]')?.getAttribute('aria-checked') === expected, initialAreaState === 'true' ? 'false' : 'true', { timeout: args.timeout });
        await areaToggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭圈选翻译"]')?.getAttribute('aria-checked') === expected, initialAreaState, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.selection.area.toggle');
      } },
      { index: 2, title: '全文悬浮球设置', file: 'drawer-floating.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        const toggle = panel.getByRole('switch', { name: '启用或关闭全文翻译悬浮球' });
        if (await toggle.getAttribute('aria-checked') === 'true') {
          await toggle.evaluate(element => element.click());
        }
        try {
          await page.waitForFunction(() => document.querySelector('.popup-drawer button.switch[role="switch"]')?.getAttribute('aria-checked') === 'false', null, { timeout: args.timeout });
        } catch {
          const state = await panel.evaluate(element => ({ text: element.textContent, switches: [...element.querySelectorAll('button[role="switch"]')].map(item => item.getAttribute('aria-checked')) }));
          fail(`悬浮球关闭状态未更新：${JSON.stringify(state)}`);
        }
        recordCase(result, 'popup.drawer.floating.disabled');
        await toggle.evaluate(element => element.click());
        try {
          await page.waitForFunction(() => document.querySelector('.popup-drawer button.switch[role="switch"]')?.getAttribute('aria-checked') === 'true', null, { timeout: args.timeout });
        } catch {
          const state = await panel.evaluate(element => ({ text: element.textContent, switches: [...element.querySelectorAll('button[role="switch"]')].map(item => item.getAttribute('aria-checked')) }));
          fail(`悬浮球启用状态未恢复：${JSON.stringify(state)}`);
        }
        recordCase(result, 'popup.drawer.floating.enabled');
        for (const choice of ['页面左侧', '页面右侧']) {
          const button = panel.getByRole('button', { name: choice, exact: true });
          await button.click({ force: true });
          await page.waitForFunction(target => [...document.querySelectorAll('.popup-drawer .chips button')]
            .some(element => element.textContent?.trim() === target && element.classList.contains('selected')), choice, { timeout: args.timeout });
          recordCase(result, `popup.drawer.floating.position.${choice}`);
        }
        const hotkeySelect = panel.locator('select');
        for (const option of await hotkeySelect.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, label: element.textContent?.trim() || '' })).filter(item => item.value !== 'custom'))) {
          await hotkeySelect.selectOption(option.value);
          if (await hotkeySelect.inputValue() !== option.value) fail(`悬浮球快捷键未更新：${option.label}`);
          recordCase(result, `popup.drawer.floating.hotkey.${option.value}`, { label: option.label });
        }
        await hotkeySelect.selectOption('custom');
        const dialog = page.getByRole('dialog', { name: '自定义快捷键' });
        await dialog.waitFor({ state: 'visible', timeout: args.timeout });
        await dialog.getByRole('button', { name: 'F10', exact: true }).click();
        await dialog.getByRole('button', { name: '确认', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: args.timeout });
        recordCase(result, 'popup.drawer.floating.custom.confirm');
      } },
      { index: 3, title: '译文显示设置', file: 'drawer-appearance.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        for (const mode of ['仅译文模式', '双语对照模式']) {
          const button = panel.getByRole('button', { name: mode, exact: true });
          await button.click({ force: true });
          await page.waitForFunction(target => [...document.querySelectorAll('.popup-drawer .chips button')]
            .some(element => element.textContent?.trim() === target && element.classList.contains('selected')), mode, { timeout: args.timeout });
          recordCase(result, `popup.drawer.appearance.mode.${mode}`);
        }
        const styleSelect = panel.locator('select').first();
        for (const option of await styleSelect.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, label: element.textContent?.trim() || '' })))) {
          await styleSelect.selectOption(option.value);
          if (await styleSelect.inputValue() !== option.value) fail(`popup 译文样式未更新：${option.label}`);
          recordCase(result, `popup.drawer.appearance.style.${option.value}`, { label: option.label });
        }
        const themeSelect = panel.locator('select').nth(1);
        for (const option of await themeSelect.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, label: element.textContent?.trim() || '' })))) {
          await themeSelect.selectOption(option.value);
          if (await themeSelect.inputValue() !== option.value) fail(`popup 主题未更新：${option.label}`);
          recordCase(result, `popup.drawer.appearance.theme.${option.value}`, { label: option.label });
        }
      } },
      { index: 4, title: '图片翻译设置', file: 'drawer-image.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        const toggle = panel.getByRole('switch', { name: '启用或关闭图片翻译' });
        const initial = await toggle.getAttribute('aria-checked');
        await toggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭图片翻译"]')?.getAttribute('aria-checked') === expected, initial === 'true' ? 'false' : 'true', { timeout: args.timeout });
        await toggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭图片翻译"]')?.getAttribute('aria-checked') === expected, initial, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.image.toggle');
      } },
      { index: 5, title: '视频字幕设置', file: 'drawer-video.png', action: async page => {
        const panel = page.locator('.popup-drawer');
        const toggle = panel.getByRole('switch', { name: '启用或关闭视频字幕翻译' });
        const initial = await toggle.getAttribute('aria-checked');
        await toggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭视频字幕翻译"]')?.getAttribute('aria-checked') === expected, initial === 'true' ? 'false' : 'true', { timeout: args.timeout });
        await toggle.click({ force: true });
        await page.waitForFunction(expected => document.querySelector('.popup-drawer button[aria-label="启用或关闭视频字幕翻译"]')?.getAttribute('aria-checked') === expected, initial, { timeout: args.timeout });
        recordCase(result, 'popup.drawer.video.toggle');
      } },
    ];

    for (const drawer of drawers) {
      await popup.locator('.feature-card').nth(drawer.index).click();
      const panel = popup.locator('.popup-drawer');
      await panel.waitFor({ state: 'visible', timeout: args.timeout });
      await popup.getByRole('heading', { name: drawer.title }).waitFor();
      await popup.waitForFunction(() => {
        const element = document.querySelector('.popup-drawer');
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.top < window.innerHeight - 1 && rect.bottom <= window.innerHeight + 1;
      }, undefined, { timeout: args.timeout });
      const box = await panel.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > 601) {
        await screenshot(popup, artifactsDir, `failed-${drawer.file}`, result);
        fail(`${drawer.title} 超出 popup 可视区域：${JSON.stringify(box)}`);
      }
      await drawer.action(popup);
      await screenshot(popup, artifactsDir, drawer.file, result);
      await panel.getByLabel('关闭', { exact: true }).click();
      await panel.waitFor({ state: 'hidden', timeout: args.timeout });
      recordCase(result, `popup.drawer.${drawer.title}.open-close`);
    }
    result.assertions.allDrawers = true;

    for (const drawerIndex of [0, 1, 2, 3, 5]) {
      const linkPopup = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, `popup-drawer-link-${drawerIndex}`, result.errors, args.timeout, 'light');
      await linkPopup.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
      await linkPopup.waitForTimeout(250);
      await linkPopup.locator('.feature-card').nth(drawerIndex).click();
      const linkPanel = linkPopup.locator('.popup-drawer');
      await linkPanel.waitFor({ state: 'visible', timeout: args.timeout });
      const optionsPagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await linkPanel.getByRole('button', { name: /在完整设置中查看全部选项/ }).click();
      const linkedOptions = await optionsPagePromise || await waitForOptionsPage(context, optionsUrl, Math.min(args.timeout, 5000));
      await linkedOptions.locator('.settings-app').waitFor({ state: 'visible', timeout: args.timeout });
      recordCase(result, `popup.drawer.${drawerIndex}.open-options-link`);
      await linkPopup.close().catch(() => {});
    }

    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
    await popup.locator('.feature-card').first().click();
    await popup.locator('.popup-drawer').waitFor({ state: 'visible', timeout: args.timeout });
    if (!await popup.locator('.popup-drawer').getByRole('button', { name: '自定义', exact: true }).evaluate(element => element.classList.contains('selected'))) fail('popup 设置在重载后没有持久化');
    if (!await popup.locator('.popup-drawer').getByRole('button', { name: '当前：Alt+Q', exact: true }).isVisible()) fail('popup 自定义快捷键在重载后没有持久化');
    await popup.locator('.popup-drawer').getByLabel('关闭', { exact: true }).click();
    result.assertions.storagePersistence = true;

    popupDark = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, 'popup-dark', result.errors, args.timeout, 'dark');
    await popupDark.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
    await popupDark.waitForTimeout(250);
    const darkApplied = await popupDark.evaluate(() => document.documentElement.classList.contains('dark'));
    if (!darkApplied) fail('跟随系统时没有应用深色主题');
    await screenshot(popupDark, artifactsDir, 'popup-dark.png', result);
    result.assertions.darkTheme = true;
    }

    if (runOptions) {
    await activateExtensionTabWithoutForeground(context, popup, Math.min(args.timeout, 10000));
    await popup.getByTitle('完整设置').click();
    options = await waitForOptionsPage(context, optionsUrl, Math.min(args.timeout, 15000));
    await capturePageErrors(options, 'options');
    await options.setViewportSize({ width: 1440, height: 1000 });
    await options.locator('.settings-app').waitFor({ state: 'visible', timeout: args.timeout });
    result.assertions.openOptionsFromPopup = true;

    const navButtons = options.locator('nav[aria-label="设置分类"] button');
    if (await navButtons.count() !== 8) fail('设置页导航分类数量不是 8');
    if (wants('options')) {
    const navigationChecks = [
      { id: 'settings-general', heading: '调整你的阅读体验', file: 'options-general.png' },
      { id: 'settings-services', heading: '配置翻译服务与模型', file: 'options-services.png' },
      { id: 'settings-shortcuts', heading: '让翻译顺手发生', file: 'options-shortcuts.png' },
      { id: 'settings-image-translation', heading: '管理图片翻译语言', file: 'options-image-translation.png' },
      { id: 'settings-video', heading: '边看边译视频字幕', file: 'options-video.png' },
      { id: 'settings-advanced', heading: '精细控制运行方式', file: 'options-advanced.png' },
      { id: 'settings-data', heading: '备份与迁移配置', file: 'options-data.png' },
      { id: 'settings-about', heading: '关于流畅阅读', file: 'options-about.png' },
    ];
    for (let index = 0; index < navigationChecks.length; index += 1) {
      const { id, heading, file } = navigationChecks[index];
      const anchor = options.locator(`#${id}`);
      const anchorCount = await anchor.count();
      if (anchorCount > 1) fail(`设置锚点重复：${id}`);
      await navButtons.nth(index).click();
      if (!await navButtons.nth(index).evaluate(element => element.classList.contains('active'))) fail(`导航未激活：${id}`);
      if (await anchor.count() !== 1) fail(`导航后设置锚点缺失：${id}`);
      await options.getByRole('heading', { name: heading, level: 1 }).waitFor({ state: 'visible', timeout: args.timeout });
      if (id === 'settings-about' && await options.locator('.settings-card > .card-intro').count() !== 0) {
        fail('关于页面仍显示重复的外层介绍卡');
      }
      for (const check of navigationChecks) {
        const visible = await options.locator(`#${check.id}`).isVisible();
        if (visible !== (check.id === id)) fail(`导航 ${id} 的页面可见性错误：${check.id}=${visible}`);
      }
      await screenshot(options, artifactsDir, file, result);
    }
    result.assertions.optionsNavigation = true;

    await navButtons.nth(0).click();
    const optionsPluginSwitch = options.locator('.settings-status-row .el-switch');
    const statusRow = options.locator('.settings-status-row');
    if (await statusRow.count() !== 1 || await optionsPluginSwitch.count() !== 1) fail('通用设置缺少统一的插件状态卡');
    await optionsPluginSwitch.click();
    if (!await options.locator('.settings-status-badge').getByText('已暂停', { exact: true }).isVisible()) fail('通用设置暂停状态没有同步更新');
    recordCase(result, 'options.general.plugin.disabled');
    await optionsPluginSwitch.click();
    if (!await options.locator('.settings-status-badge').getByText('已启用', { exact: true }).isVisible()) fail('通用设置启用状态没有同步恢复');
    recordCase(result, 'options.general.plugin.enabled');
    const generalRowSelect = label => options.locator('#settings-general .el-row').filter({ hasText: label }).first().locator('.el-select');
    const displaySelect = generalRowSelect('翻译模式');
    const defaultTargetSelect = generalRowSelect('默认目标语言');
    if (await defaultTargetSelect.count() !== 1) fail('通用设置缺少默认目标语言配置');
    const preferenceRightEdges = await options.locator('#settings-general .settings-preference-row').evaluateAll(rows => rows.map(row => {
      const select = row.querySelector('.el-select');
      const rect = select?.getBoundingClientRect();
      return rect && rect.width > 0 ? rect.right : null;
    }).filter(edge => edge != null));
    if (preferenceRightEdges.length < 4 || preferenceRightEdges.length > 5) {
      fail(`通用设置的可见偏好选择框布局不完整：${preferenceRightEdges.length}`);
    }
    const rightEdgeDelta = Math.max(...preferenceRightEdges) - Math.min(...preferenceRightEdges);
    if (rightEdgeDelta > 2) fail(`通用设置的可见偏好选择框没有右对齐：最大误差 ${rightEdgeDelta.toFixed(2)}px`);
    recordCase(result, 'options.general.preference-controls.align-right');
    await displaySelect.click();
    await options.getByRole('option', { name: '双语对照模式', exact: true }).click();
    const styleSelect = generalRowSelect('译文样式');
    if (!await styleSelect.isVisible() || !await options.locator('.style-preview-card').isVisible()) fail('双语模式下没有显示译文样式实时预览');
    await options.keyboard.press('Escape');
    await styleSelect.click();
    const styleDropdown = options.locator('.el-select-dropdown:visible').filter({ hasText: '加粗显示' }).last();
    await styleDropdown.waitFor({ state: 'visible', timeout: args.timeout });
    const styleLabels = await styleDropdown.locator('.el-select-dropdown__item:not(.is-disabled)').allTextContents().catch(() => []);
    await options.keyboard.press('Escape');
    if (styleLabels.length) {
      for (const label of styleLabels.map(text => text.trim()).filter(Boolean)) {
        await styleSelect.click();
        const clicked = await options.evaluate(optionLabel => {
          const dropdown = [...document.querySelectorAll('.el-select-dropdown')]
            .find(element => element.textContent?.includes('加粗显示') && element.getClientRects().length > 0);
          const item = [...(dropdown?.querySelectorAll('.el-select-dropdown__item:not(.is-disabled)') || [])]
            .find(element => element.textContent?.trim() === optionLabel && element.getClientRects().length > 0);
          if (!item) return false;
          item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          item.click();
          return true;
        }, label);
        if (!clicked) fail(`找不到可见译文样式选项：${label}`);
        await options.locator('.style-preview-text').waitFor({ state: 'visible', timeout: args.timeout });
        recordCase(result, `options.general.style.preview.${label}`);
      }
    }
    await options.waitForTimeout(250);
    await options.reload({ waitUntil: 'domcontentloaded', timeout: args.timeout });
    await options.locator('.settings-app').waitFor({ state: 'visible', timeout: args.timeout });
    const reloadedNavButtons = options.locator('nav[aria-label="设置分类"] button');
    await reloadedNavButtons.nth(0).click();
    const persistedStyle = generalRowSelect('译文样式');
    await persistedStyle.getByText('轻透明感', { exact: true }).waitFor({ state: 'visible', timeout: args.timeout });
    if (!await options.locator('.style-preview-text.fluent-display-transparent-mode').isVisible()) fail('译文样式选择没有在 options 重载后持久化');
    recordCase(result, 'options.general.style.persistence');
    result.assertions.generalSettingsUi = true;
    }

    if (wants('services')) {
    await navButtons.nth(1).click();
    const serviceCatalog = options.locator('.service-catalog');
    await serviceCatalog.waitFor({ state: 'visible', timeout: args.timeout });
    const serviceSurfaceMetrics = await options.evaluate(() => {
      const surfaceElement = document.querySelector('.settings-card.services-view');
      const surface = surfaceElement?.getBoundingClientRect();
      const workspace = document.querySelector('.workspace')?.getBoundingClientRect();
      if (!surface || !workspace) {
        return {
          missingSurface: !surface,
          missingWorkspace: !workspace,
          settingsCards: [...document.querySelectorAll('.settings-card')].map(element => element.className),
          activeNav: document.querySelector('nav button.active')?.textContent?.trim() || '',
          url: location.href,
        };
      }
      const surfaceStyle = surfaceElement ? getComputedStyle(surfaceElement) : null;
      const catalog = surfaceElement?.querySelector('.service-catalog');
      const catalogStyle = catalog ? getComputedStyle(catalog) : null;
      return {
        leftGap: Math.round(surface.left - workspace.left),
        rightGap: Math.round(workspace.right - surface.right),
        width: Math.round(surface.width),
        scrollHeight: surfaceElement?.scrollHeight || 0,
        clientHeight: surfaceElement?.clientHeight || 0,
        surfaceHeight: Math.round(surface.height),
        surfaceDisplay: surfaceStyle?.display,
        surfaceFlex: surfaceStyle?.flex,
        catalogHeight: catalog ? Math.round(catalog.getBoundingClientRect().height) : 0,
        catalogMinHeight: catalogStyle?.minHeight,
        catalogFlex: catalogStyle?.flex,
        serviceSectionHeight: surfaceElement?.querySelector('#settings-services')?.getBoundingClientRect().height || 0,
        serviceSectionFlex: surfaceElement?.querySelector('#settings-services') ? getComputedStyle(surfaceElement.querySelector('#settings-services')).flex : '',
        mainSectionsHeight: surfaceElement?.querySelector('.settings-main-sections')?.getBoundingClientRect().height || 0,
      };
    });
    if (!serviceSurfaceMetrics || serviceSurfaceMetrics.leftGap > 12 || serviceSurfaceMetrics.rightGap > 12) {
      fail(`服务目录主工作区没有铺满：${JSON.stringify(serviceSurfaceMetrics)}`);
    }
    if (serviceSurfaceMetrics.scrollHeight > serviceSurfaceMetrics.clientHeight + 1) fail(`服务页外层出现滚动：${JSON.stringify(serviceSurfaceMetrics)}`);
    result.serviceSurfaceMetrics = serviceSurfaceMetrics;
    recordCase(result, 'options.services.full-width-workspace', serviceSurfaceMetrics);
    const renderedServiceGroups = (await serviceCatalog.locator('.group-heading strong').allTextContents())
      .map(label => label.trim())
      .filter(Boolean);
    for (const groupName of ['机器翻译', 'AI翻译']) {
      if (!renderedServiceGroups.includes(groupName)) {
        fail(`翻译服务缺少分组：${groupName}；实际分组：${renderedServiceGroups.join('、') || '无'}`);
      }
    }
    const serviceItems = serviceCatalog.locator('.service-item');
    if (await serviceItems.count() < 8) fail('翻译服务列表数量异常');
    const serviceIcons = serviceItems.locator('.service-brand-icon');
    if (await serviceIcons.count() !== await serviceItems.count()) fail('设置页翻译服务图标数量不完整');
    if (await serviceIcons.locator('svg').count() !== await serviceItems.count()) fail('设置页翻译服务存在未渲染的本地图标');
    const defaultServiceBefore = await serviceCatalog.getAttribute('data-default-service');
    const editingServiceBefore = await serviceCatalog.getAttribute('data-editing-service');
    if (!defaultServiceBefore || !editingServiceBefore) fail('配置页缺少默认服务/编辑服务状态标记');
    const alternateService = await serviceItems.evaluateAll((elements, defaultServiceValue) => {
      const defaultValue = String(defaultServiceValue || '');
      const element = elements.find(item => item.getAttribute('data-service-value') !== defaultValue);
      return element?.getAttribute('data-service-value') || '';
    }, defaultServiceBefore);
    if (!alternateService) fail('配置页没有可用于验证编辑语义的其他服务');
    const alternateItem = serviceCatalog.locator(`.service-item[data-service-value="${alternateService}"]`).first();
    await alternateItem.click();
    if (await serviceCatalog.getAttribute('data-default-service') !== defaultServiceBefore) fail('切换编辑服务时改变了网页翻译默认服务');
    if (await serviceCatalog.getAttribute('data-editing-service') !== alternateService) fail('左侧点击没有切换正在配置的服务');
    const configuringBadge = serviceCatalog.getByText('正在配置', { exact: true });
    if (await configuringBadge.count() !== 1 || !await configuringBadge.isVisible()) fail('非默认服务没有显示正在配置标记');
    const defaultItem = serviceCatalog.locator(`.service-item[data-service-value="${defaultServiceBefore}"]`).first();
    if (await defaultItem.count()) {
      if (await defaultItem.locator('.current-dot').count() !== 1 || await alternateItem.locator('.current-dot').count() !== 0) {
        fail('默认服务标记随编辑目标发生了错误移动');
      }
    }
    const restoreItem = serviceCatalog.locator(`.service-item[data-service-value="${editingServiceBefore}"]`).first();
    if (await restoreItem.count()) await restoreItem.click();
    if (await serviceCatalog.getAttribute('data-default-service') !== defaultServiceBefore) fail('恢复编辑目标后默认服务发生变化');
    if (await serviceCatalog.getAttribute('data-editing-service') !== editingServiceBefore) fail('恢复编辑目标失败');
    recordCase(result, 'options.services.editing-does-not-change-default', {
      defaultService: defaultServiceBefore,
      editingService: alternateService,
    });
    const machineService = serviceItems.filter({ hasText: '微软翻译' }).first();
    await machineService.click();
    const noModelPanel = serviceCatalog.locator('.no-model-panel');
    await noModelPanel.waitFor({ state: 'visible', timeout: args.timeout });
    if (!await noModelPanel.getByText('此服务无需模型配置', { exact: true }).isVisible()) fail('机器翻译服务没有显示无需模型配置说明');
    recordCase(result, 'options.services.machine-service-no-model');
    const openAiService = serviceItems.filter({ hasText: 'OpenAI' }).first();
    await openAiService.click();
    await options.getByRole('listbox', { name: '可用模型' }).waitFor({ state: 'visible', timeout: args.timeout });
    const configurationSection = serviceCatalog.locator('.service-configuration-slot .service-connection-section');
    await configurationSection.waitFor({ state: 'visible', timeout: args.timeout });
    if (!await configurationSection.getByText('连接参数', { exact: true }).isVisible()) fail('模型选择右侧没有显示服务配置区域');
    recordCase(result, 'options.services.configuration-in-right-panel');
    const modelOptions = options.getByRole('option');
    const visibleModelOptions = options.locator('.model-item:visible');
    const commonModelCount = await visibleModelOptions.count();
    if (commonModelCount < 2 || commonModelCount > 4) fail(`OpenAI 常用模型数量异常：${commonModelCount}`);
    if (await visibleModelOptions.locator('.service-brand-icon').count() !== commonModelCount) fail('模型卡片图标数量不完整');
    const moreModelsToggle = serviceCatalog.getByRole('button', { name: /更多模型/ });
    if (await moreModelsToggle.count() !== 1) fail('OpenAI 缺少“更多模型”折叠入口');
    if (await moreModelsToggle.getAttribute('aria-expanded') !== 'false') fail('更多模型默认没有收起');
    await moreModelsToggle.click();
    if (await moreModelsToggle.getAttribute('aria-expanded') !== 'true') fail('更多模型展开状态错误');
    if (await visibleModelOptions.count() <= commonModelCount) fail('展开后没有显示更多模型');
    const customModelOption = serviceCatalog.locator('.model-item:visible').filter({ hasText: '自定义模型' }).first();
    if (await customModelOption.count() !== 1) fail('模型列表缺少自定义模型入口');
    await customModelOption.click();
    const customModelRow = configurationSection.locator('.el-row:visible').filter({ hasText: '自定义模型' }).first();
    await customModelRow.locator('.popup-text').hover();
    await options.getByRole('tooltip').filter({ hasText: '填写服务商支持的模型标识' }).last().waitFor({ state: 'visible', timeout: args.timeout });
    recordCase(result, 'options.services.configuration.custom-model-tooltip');
    await options.keyboard.press('Escape');
    const scrollLayout = await options.evaluate(() => {
      const rail = document.querySelector('.service-rail');
      const grid = document.querySelector('.model-grid');
      return {
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientHeight: document.documentElement.clientHeight,
        railScrollHeight: rail?.scrollHeight || 0,
        railClientHeight: rail?.clientHeight || 0,
        modelScrollHeight: grid?.scrollHeight || 0,
        modelClientHeight: grid?.clientHeight || 0,
      };
    });
    result.optionsScrollLayout = scrollLayout;
    if (scrollLayout.documentScrollHeight > scrollLayout.documentClientHeight + 1) fail(`设置页外层出现页面滚动：${JSON.stringify(scrollLayout)}`);
    if (scrollLayout.railScrollHeight <= scrollLayout.railClientHeight) fail(`服务列表没有独立滚动区域：${JSON.stringify(scrollLayout)}`);
    if (scrollLayout.modelScrollHeight <= scrollLayout.modelClientHeight) fail(`模型列表没有独立滚动区域：${JSON.stringify(scrollLayout)}`);
    recordCase(result, 'options.services.fixed-viewport-independent-scroll');
    await screenshot(options, artifactsDir, 'options-models-expanded.png', result);
    const candidateModel = visibleModelOptions.nth(commonModelCount);
    const candidateModelName = (await candidateModel.locator('strong').textContent() || '').trim();
    await candidateModel.click();
    if (!candidateModelName || !await serviceCatalog.locator('.model-grid .model-item.active').filter({ hasText: candidateModelName }).isVisible()) {
      fail('更多模型中的选择没有成为当前常用模型');
    }
    await moreModelsToggle.click();
    if (await visibleModelOptions.count() !== commonModelCount) fail('更多模型无法重新收起');
    const serviceSearch = serviceCatalog.getByPlaceholder('搜索翻译服务');
    await serviceSearch.fill('DeepSeek');
    if (await serviceCatalog.locator('.service-item').count() !== 1) fail('翻译服务搜索没有收敛到唯一结果');
    await serviceSearch.fill('');
    const modelSearch = serviceCatalog.getByPlaceholder('搜索模型');
    if (await modelSearch.count()) {
      await modelSearch.fill(candidateModelName);
      if (!candidateModelName || !await serviceCatalog.locator('.model-item:visible').filter({ hasText: candidateModelName }).isVisible()) fail(`模型搜索无法找到折叠区域中的模型：${candidateModelName}`);
      if (await moreModelsToggle.isVisible()) fail('模型搜索时仍显示多余的折叠入口');
      await modelSearch.fill('');
      if (await moreModelsToggle.getAttribute('aria-expanded') !== 'false') fail('清空模型搜索后没有恢复收起状态');
    }
    const aiServiceItems = serviceCatalog.locator('.service-group')
      .filter({ has: serviceCatalog.locator('.group-heading strong').filter({ hasText: 'AI翻译' }) })
      .locator('.service-item');
    for (let index = 0; index < await aiServiceItems.count(); index += 1) {
      const aiServiceItem = aiServiceItems.nth(index);
      const aiServiceLabel = (await aiServiceItem.locator('.service-copy strong').textContent() || '').trim();
      if (/Coze|扣子/i.test(aiServiceLabel)) continue;
      await aiServiceItem.click();
      const serviceModelSection = serviceCatalog.locator('.model-section:visible');
      if (await serviceModelSection.count() !== 1) fail(`${aiServiceLabel} 没有模型配置区域`);
      const serviceMoreModelsToggle = serviceCatalog.getByRole('button', { name: /更多模型/ });
      if (await serviceMoreModelsToggle.count() === 1 && await serviceMoreModelsToggle.getAttribute('aria-expanded') === 'false') {
        await serviceMoreModelsToggle.click();
      }
      if (await serviceCatalog.locator('.model-item:visible').filter({ hasText: '自定义模型' }).count() !== 1) {
        fail(`${aiServiceLabel} 缺少自定义模型入口`);
      }
      if (await serviceMoreModelsToggle.count() === 1 && await serviceMoreModelsToggle.getAttribute('aria-expanded') === 'true') {
        await serviceMoreModelsToggle.click();
      }
    }
    recordCase(result, 'options.services.all-model-based-ai-custom-models');
    result.assertions.serviceCatalog = true;
    await screenshot(options, artifactsDir, 'options-service-catalog.png', result);
    }

    if (wants('options')) {
    const optionsAudit = await auditDom(options);
    if (optionsAudit.duplicateIds.length) fail(`设置页存在重复 ID：${optionsAudit.duplicateIds.join(', ')}`);
    if (optionsAudit.unnamedInteractive.length) result.warnings.push(`设置页存在 ${optionsAudit.unnamedInteractive.length} 个旧控件缺少可访问名称`);
    result.optionsAudit = optionsAudit;
    await screenshot(options, artifactsDir, 'options-desktop.png', result);

    const search = options.getByPlaceholder(/搜索设置/);
    await search.fill('快捷键');
    if (await options.locator('.search-results button').count() < 1) fail('设置搜索没有返回快捷键结果');
    await options.locator('.search-results button').first().click();
    if (await search.inputValue() !== '') fail('点击搜索结果后没有清空查询');
    await search.fill('OpenAI');
    if (await options.locator('.search-results button').count() !== 1) fail('OpenAI 搜索没有定位到翻译服务分类');
    await options.locator('.search-results button').click();
    await options.getByRole('heading', { name: '配置翻译服务与模型', level: 1 }).waitFor({ state: 'visible' });
    await search.fill('一定不存在的设置关键词');
    if (!await options.locator('.search-empty').isVisible()) fail('设置搜索无结果状态没有显示');
    await search.fill('');
    result.assertions.optionsSearch = true;
    }

    if (wants('responsive')) {
    result.responsiveMetrics = [];
    for (const viewport of [
      { width: 1024, height: 900, file: 'options-1024.png' },
      { width: 820, height: 900, file: 'options-820.png' },
      { width: 390, height: 844, file: 'options-mobile.png' },
    ]) {
      await options.setViewportSize({ width: viewport.width, height: viewport.height });
      await options.waitForTimeout(250);
      const current = await popupMetrics(options);
      result.responsiveMetrics.push({ viewport: viewport.width, ...current });
      if (current.horizontalOverflow) fail(`${viewport.width}px 设置页出现横向滚动：${JSON.stringify(current)}`);
      await screenshot(options, artifactsDir, viewport.file, result);
    }
    result.assertions.responsiveOptions = true;
    }

    if (wants('isolation')) {
    hostileCssServer = await startHostileCssServer();
    const hostilePage = await openExtensionPage(
      context,
      hostileCssServer.url,
      { width: 1280, height: 900 },
      'hostile-css-page',
      result.errors,
      args.timeout,
      'light',
    );
    result.contentScriptInjection = await injectDevContentScript(worker, manifest, extensionDir, hostilePage);
    await hostilePage.locator('#fluent-read-page-styles').waitFor({ state: 'attached', timeout: args.timeout });
    await hostilePage.locator('#fluent-read-floating-ball-container').waitFor({ state: 'attached', timeout: args.timeout });
    await hostilePage.locator('#fluent-read-selection-translator-container').waitFor({ state: 'attached', timeout: args.timeout });
    const isolation = await hostilePage.evaluate(() => {
      const hostileControl = document.getElementById('hostile-control');
      const floatingHost = document.getElementById('fluent-read-floating-ball-container');
      const selectionHost = document.getElementById('fluent-read-selection-translator-container');
      const floatingRoot = floatingHost?.shadowRoot;
      const selectionRoot = selectionHost?.shadowRoot;
      const ball = floatingRoot?.querySelector('.fr-floating-ball');
      const icon = floatingRoot?.querySelector('.floating-ball-icon');
      const selectionWrapper = selectionRoot?.querySelector('.fr-selection-translator-root');
      const hostileStyle = hostileControl ? getComputedStyle(hostileControl) : null;
      const ballStyle = ball ? getComputedStyle(ball) : null;
      const iconStyle = icon ? getComputedStyle(icon) : null;
      const selectionStyle = selectionWrapper ? getComputedStyle(selectionWrapper) : null;
      return {
        hostileFontSize: hostileStyle?.fontSize,
        hostilePosition: hostileStyle?.position,
        floatingHasShadowRoot: Boolean(floatingRoot),
        selectionHasShadowRoot: Boolean(selectionRoot),
        ballPosition: ballStyle?.position,
        ballBorderRadius: ballStyle?.borderRadius,
        iconWidth: iconStyle?.width,
        iconHeight: iconStyle?.height,
        iconBorderRadius: iconStyle?.borderRadius,
        selectionPosition: selectionStyle?.position,
      };
    });
    result.cssIsolation = isolation;
    if (isolation.hostileFontSize !== '42px' || isolation.hostilePosition !== 'static') fail('宿主页面的恶意 CSS 测试规则没有生效');
    if (!isolation.floatingHasShadowRoot || !isolation.selectionHasShadowRoot) fail('悬浮球或划词翻译未挂载到 Shadow Root');
    if (isolation.ballPosition !== 'fixed') fail(`悬浮球 position 被宿主 CSS 污染：${isolation.ballPosition}`);
    if (isolation.iconWidth !== '24px' || isolation.iconHeight !== '24px') fail(`悬浮球尺寸被宿主 CSS 污染：${isolation.iconWidth} × ${isolation.iconHeight}`);
    if (isolation.iconBorderRadius === '0px') fail('悬浮球圆角被宿主 CSS 污染');
    if (isolation.selectionPosition !== 'fixed') fail(`划词翻译定位层 position 被宿主 CSS 污染：${isolation.selectionPosition}`);
    result.assertions.shadowDomIsolation = true;
    await screenshot(hostilePage, artifactsDir, 'hostile-css-shadow-isolation.png', result);
    }
    }

    if (popupDark) await popupDark.waitForTimeout(300);
    if (options) await options.waitForTimeout(300);
    await diagnostics.flush();
    diagnostics.assertClean();

    if (wants('full')) {
      diagnostics.setPhase('runtime-reload');
      const reloadedWorkerPromise = context.waitForEvent('serviceworker', { timeout: Math.min(args.timeout, 15000) });
      await worker.evaluate(() => chrome.runtime.reload());
      const reloadedWorker = await reloadedWorkerPromise;
      // start() 已持续监听新建后台 target；等待重连完成后再作门禁断言。
      await new Promise(resolve => setTimeout(resolve, 800));
      const popupAfterReload = await openExtensionPage(context, popupUrl, { width: 400, height: 600 }, 'popup-after-reload', result.errors, args.timeout, 'light');
      await popupAfterReload.locator('.popup-shell').waitFor({ state: 'visible', timeout: args.timeout });
      await popupAfterReload.waitForTimeout(800);
      await diagnostics.flush();
      diagnostics.assertClean();
      result.assertions.runtimeReload = true;
    }

    result.ok = true;
  } catch (error) {
    caughtError = error;
    result.error = redact(error.message);
    throw error;
  } finally {
    result.auditWarnings = [...result.warnings];
    await finalizeRun({
      diagnostics, result, artifactsDir, primaryError: caughtError,
      cleanup: [
        { stage: 'browser-close', action: async () => {
          if (browserSession) {
            await browserSession.close();
            browserClosed = true;
          }
        } },
        { stage: 'http-server-close', action: async () => {
          if (hostileCssServer) await new Promise(resolve => hostileCssServer.server.close(resolve));
        } },
        { stage: 'profile-cleanup', action: () => {
          if (!suppliedProfile && !args.keepProfile && browserClosed) fs.rmSync(profileDir, { recursive: true, force: true });
          else if (!suppliedProfile && !browserClosed) process.stderr.write(`已保留临时浏览器配置：${profileDir}\n`);
        } },
      ],
      emitReport: value => process.stdout.write(`${JSON.stringify(browserReport(value, artifactsDir, args.reportFormat), null, 2)}\n`),
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    process.stderr.write(`${redact(error.stack || error.message)}\n`);
    process.exit(1);
  });
