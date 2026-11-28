#!/usr/bin/env node

const fs = require('node:fs');
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

// 统一抛出可读错误，由入口处负责打印堆栈并设置退出码。
function fail(message) {
  throw new Error(message);
}

// 解析简单的 --key value 参数，并保留稳定的英文参数名。
function parseArgs(argv) {
  const args = {
    url: 'https://example.com',
    selector: 'p',
    translatedSelector: '.fluent-read-bilingual-content',
    injectedSelector: '#fluent-read-page-styles',
    expectedHotkey: 'Control',
    timeout: 120000,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    reportFormat: 'summary',
    keepProfile: false,
    headless: false,
    background: true,
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
  return args;
}

// 优先使用项目可解析的 Playwright；否则从 Codex 捆绑依赖目录加载。
function loadPlaywright(playwrightRoot) {
  try {
    return require('playwright');
  } catch (localError) {
    if (!playwrightRoot) {
      fail(`无法加载 Playwright。请传入 --playwright-root <node_modules>。原始错误：${localError.message}`);
    }
    const root = path.resolve(playwrightRoot);
    if (!fs.existsSync(root)) fail(`Playwright 依赖目录不存在：${root}`);
    const requireFromRuntime = createRequire(path.join(root, '__fluentread_skill_loader__.cjs'));
    return requireFromRuntime('playwright');
  }
}

function normalizeConfig(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
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

// 通过插件弹窗页读取 chrome.storage.local，避免直接接触网页上下文。
async function readExtensionConfig(context, timeout) {
  let workers = context.serviceWorkers();
  if (workers.length === 0) {
    try {
      workers = [await context.waitForEvent('serviceworker', { timeout: Math.min(timeout, 30000) })];
    } catch {
      return { extensionId: null, config: null };
    }
  }

  const workerUrl = workers[0].url();
  const match = workerUrl.match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) return { extensionId: null, config: null };

  const extensionId = match[1];
  const popup = await newPageWithoutForeground(context, Math.min(timeout, 10000));
  diagnostics.setExtensionId(extensionId);
  await diagnostics.attachPage(popup, 'config-popup');
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const stored = await popup.evaluate(async () => chrome.storage.local.get('config'));
    return { extensionId, config: normalizeConfig(stored.config) };
  } finally {
    await popup.close();
  }
}

// 只公开验证所需的配置字段，不输出令牌等凭据。
function publicConfig(config) {
  if (!config) return null;
  return {
    on: config.on,
    from: config.from,
    to: config.to,
    display: config.display,
    style: config.style,
    hotkey: config.hotkey,
    service: config.service,
    model: config.model,
  };
}

// 统计目标段落内部的译文节点，避免相邻内容干扰断言。
async function countTranslations(target, translatedSelector) {
  return target.locator(translatedSelector).count();
}

// 等待 DOM 达到指定译文数量，确保三次操作严格串行。
async function waitForCount(page, targetSelector, translatedSelector, expected, timeout) {
  await page.waitForFunction(
    ({ targetSelector: selector, translatedSelector: childSelector, expected: count }) => {
      const target = document.querySelector(selector);
      return target ? target.querySelectorAll(childSelector).length === count : false;
    },
    { targetSelector, translatedSelector, expected },
    { timeout },
  );
}

// 动态站点可能先插入空壳节点，再异步替换正文；手势前必须等待可见文本稳定。
async function waitForStableTarget(page, targetSelector, timeout) {
  await page.waitForFunction(
    selector => {
      const target = document.querySelector(selector);
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && Boolean(target.textContent?.trim());
    },
    targetSelector,
    { timeout },
  );
  await page.waitForTimeout(1000);
}

// 执行真实浏览器手势。Control 必须用 down/up 发送，不能构造 DOM 键盘事件。
async function gesture(page, target, targetSelector, translatedSelector, expectedCount, timeout) {
  const box = await target.boundingBox();
  if (!box) fail(`目标元素不可见：${targetSelector}`);
  const x = box.x + Math.min(Math.max(box.width * 0.35, 8), Math.max(box.width - 8, 8));
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await waitForCount(page, targetSelector, translatedSelector, expectedCount, timeout);
  return countTranslations(target, translatedSelector);
}

// Edge 初次启动偶尔会中止首次导航，仅对 ERR_ABORTED 做有限重试。
async function navigateWithRetry(page, url, timeout) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (error) {
      lastError = error;
      const isStartupAbort = String(error.message).includes('net::ERR_ABORTED');
      if (!isStartupAbort || attempt === 3) throw error;
      await page.waitForTimeout(750 * attempt);
    }
  }
  throw lastError;
}

// 完整验证：启动隔离浏览器、读取配置、执行三态切换、保存证据并清理。
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.extensionDir) fail('必须传入 --extension-dir');

  const extensionDir = path.resolve(args.extensionDir);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`找不到插件清单：${manifestPath}`);
  if (!fs.existsSync(args.browserPath)) fail(`找不到浏览器可执行文件：${args.browserPath}`);

  const artifactsDir = args.artifactsDir ? path.resolve(args.artifactsDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-toggle-evidence-'));
  fs.mkdirSync(artifactsDir, { recursive: true });

  const requestedDisplay = args.display ?? args.displayIndex ?? 'secondary';
  const displayTarget = args.background && !args.headless ? resolveBackgroundDisplayTarget(requestedDisplay) : requestedDisplay;
  const suppliedProfile = Boolean(args.profileDir);
  const profileDir = suppliedProfile
    ? path.resolve(args.profileDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-edge-profile-'));
  if (suppliedProfile) fs.mkdirSync(profileDir, { recursive: true });
  assertDedicatedProfile(profileDir, suppliedProfile);
  const { chromium } = loadPlaywright(args.playwrightRoot);
  let context;
  let browserSession;
  let browserClosed = false;
  const result = {
    ok: false,
    browser: 'Microsoft Edge',
    extensionDir,
    profileDir,
    profileMode: suppliedProfile ? 'supplied-dedicated' : 'generated-temporary',
    url: args.url,
    selector: args.selector,
    windowMode: args.headless ? 'headless' : args.background ? 'background-visible-no-focus' : 'headed-centered',
    displayTarget,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    counts: [],
    neighborCounts: [],
    screenshots: [],
    artifactsDir,
  };
  diagnostics = createRuntimeDiagnostics();
  let caughtError;

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

    const page = await newPageWithoutForeground(context, Math.min(args.timeout, 10000));
    await diagnostics.attachPage(page, 'translation-page');
    diagnostics.setPhase('page-load');
    await navigateWithRetry(page, args.url, args.timeout);
    await page.waitForSelector(args.injectedSelector, { state: 'attached', timeout: Math.min(args.timeout, 45000) });
    await waitForStableTarget(page, args.selector, args.timeout);

    const { extensionId, config } = await readExtensionConfig(context, args.timeout);
    result.extensionId = extensionId;
    result.config = publicConfig(config);
    if (!config) fail('无法从 chrome.storage.local 读取 FluentRead 配置');
    if (config.on !== true) fail('当前浏览器配置中的 FluentRead 未启用');
    if (Number(config.display) !== 1) fail(`预期双语模式 display=1，实际为 ${config.display}`);
    if (args.expectedHotkey && config.hotkey !== args.expectedHotkey) {
      fail(`预期快捷键为 ${args.expectedHotkey}，实际为 ${config.hotkey}`);
    }
    if (args.expectedService && config.service !== args.expectedService) {
      fail(`预期翻译服务为 ${args.expectedService}，实际为 ${config.service}`);
    }

    // 读取扩展配置时会短暂打开 popup；只在隔离 Edge 内激活页签，不把 Edge 带到 macOS 前台。
    await activateExtensionTabWithoutForeground(context, page, Math.min(args.timeout, 10000));
    const targets = page.locator(args.selector);
    if (await targets.count() === 0) fail(`没有元素匹配选择器：${args.selector}`);
    const target = targets.first();
    const neighbor = targets.nth(1);
    const hasNeighbor = await targets.count() > 1;
    const initialUrl = page.url();

    for (const expected of [1, 0, 1]) {
      diagnostics.setPhase(`translation-toggle-${result.counts.length + 1}`);
      const count = await gesture(page, target, args.selector, args.translatedSelector, expected, args.timeout);
      result.counts.push(count);
      const neighborCount = hasNeighbor ? await countTranslations(neighbor, args.translatedSelector) : 0;
      result.neighborCounts.push(neighborCount);
      if (neighborCount !== 0) fail(`状态 ${expected} 下相邻段落被意外翻译`);
      if (page.url() !== initialUrl) fail(`页面发生意外跳转：${page.url()}`);

      if (artifactsDir && expected === 1) {
        const occurrence = result.counts.length === 1 ? 'first-translation' : 'final-translation';
        const screenshotPath = path.join(artifactsDir, `${occurrence}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        result.screenshots.push(screenshotPath);
      }
    }

    const translationText = (await target.locator(args.translatedSelector).first().textContent() || '').trim();
    result.translationText = translationText;
    if (!/[\u3400-\u9fff]/u.test(translationText)) fail(`最终译文不包含中文字符：${translationText}`);
    if (args.expectedText && !translationText.includes(args.expectedText)) {
      fail(`未找到预期译文片段：${args.expectedText}`);
    }

    await diagnostics.flush();
    diagnostics.assertClean();
    result.ok = true;
  } catch (error) {
    caughtError = error;
    result.error = redact(error.message);
    throw error;
  } finally {
    await finalizeRun({
      diagnostics, result, artifactsDir, primaryError: caughtError,
      cleanup: [
        { stage: 'browser-close', action: async () => {
          if (browserSession) {
            await browserSession.close();
            browserClosed = true;
          }
        } },
        { stage: 'profile-cleanup', action: () => {
          if (!suppliedProfile && !args.keepProfile && browserClosed) fs.rmSync(profileDir, { recursive: true, force: true });
          else if (!suppliedProfile) process.stderr.write(`已保留临时浏览器配置：${profileDir}\n`);
        } },
      ],
      emitReport: value => process.stdout.write(`${JSON.stringify(browserReport(value, artifactsDir, args.reportFormat), null, 2)}\n`),
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error.stack || error.message)}\n`);
  process.exitCode = 1;
});
