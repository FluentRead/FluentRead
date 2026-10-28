'use strict';

/**
 * @file scripts/testing/focus-safe-browser.cjs
 * Helpers for isolated browser regression tests: keep visible macOS background
 * windows on the requested display without taking foreground focus, create and
 * activate test pages, and route native macOS CDP session cleanup through guarded close.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { guardBrowserClose, getGuardedBrowserPid } = require('./owned-browser-close.cjs');

const execFileAsync = promisify(execFile);
const backgroundContexts = new WeakMap();
const foregroundNativeContexts = new WeakMap();
const macScreenQueryScript = [
  "ObjC.import('AppKit');",
  'const screens = $.NSScreen.screens;',
  'const count = Number(screens.count);',
  'const main = count > 0 ? screens.objectAtIndex(0) : null;',
  'const frameData = frame => ({ x: Number(frame.origin.x), y: Number(frame.origin.y), width: Number(frame.size.width), height: Number(frame.size.height) });',
  'const mainFrame = count > 0 ? frameData(main.frame) : null;',
  'const result = [];',
  'for (let index = 0; index < count; index += 1) {',
  '  const screen = screens.objectAtIndex(index);',
  '  const frame = frameData(screen.frame);',
  '  const visible = frameData(screen.visibleFrame);',
  '  const isMain = Boolean(mainFrame && frame.x === mainFrame.x && frame.y === mainFrame.y && frame.width === mainFrame.width && frame.height === mainFrame.height);',
  '  result.push({ index, frame, visible, isMain });',
  '}',
  'JSON.stringify({ main: mainFrame, screens: result });',
].join('\n');
const macFrontmostApplicationScript = [
  "ObjC.import('AppKit');",
  'const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
  "JSON.stringify({ pid: Number(app.processIdentifier), name: ObjC.unwrap(app.localizedName) || '' });",
].join('\n');

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function queryMacScreenLayout() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      macScreenQueryScript,
    ], { timeout: 5000 });
    const layout = JSON.parse(stdout.trim());
    return Array.isArray(layout?.screens) && layout.screens.length > 0 ? layout : null;
  } catch {
    return null;
  }
}

async function queryMacFrontmostApplication() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      macFrontmostApplicationScript,
    ], { timeout: 5000 });
    const application = JSON.parse(stdout.trim());
    return Number.isInteger(application?.pid) && application.pid > 0 ? application : null;
  } catch {
    return null;
  }
}

function normalizeDisplayTarget(displayTarget) {
  if (displayTarget == null || displayTarget === '') return 'secondary';
  const value = String(displayTarget).trim().toLowerCase();
  if (value === 'current' || value === 'active' || value === 'auto') return 'current';
  if (value === 'secondary' || value === 'second') return 'secondary';
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : 'secondary';
}

function selectMacDisplay(layout, displayTarget) {
  if (!layout?.screens?.length || displayTarget === 'current') return null;
  if (Number.isInteger(displayTarget)) {
    return layout.screens.find(screen => screen.index === displayTarget) || null;
  }
  return layout.screens.find(screen => !screen.isMain) || layout.screens[0];
}

function resolveVisibleDisplayBounds(layout, displayTarget, currentScreen) {
  const selected = selectMacDisplay(layout, displayTarget);
  if (!selected?.visible) {
    return {
      left: currentScreen.left,
      top: currentScreen.top,
      width: currentScreen.width,
      height: currentScreen.height,
      source: 'browser-current-screen',
      screenIndex: null,
    };
  }

  const main = layout.main || layout.screens.find(screen => screen.isMain)?.frame;
  const mainMaxY = main ? main.y + main.height : null;
  if (!Number.isFinite(mainMaxY)) {
    return {
      left: currentScreen.left,
      top: currentScreen.top,
      width: currentScreen.width,
      height: currentScreen.height,
      source: 'browser-current-screen',
      screenIndex: null,
    };
  }

  return {
    // NSScreen uses a bottom-left origin; Chromium window bounds use the
    // top-left virtual-desktop origin. Convert only the vertical coordinate.
    left: selected.visible.x,
    top: mainMaxY - selected.visible.y - selected.visible.height,
    width: selected.visible.width,
    height: selected.visible.height,
    source: 'macos-nsscreen',
    screenIndex: selected.index,
  };
}

function fitWindowToDisplay(width, height, display) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 0));
  const safeHeight = Math.max(1, Math.round(Number(height) || 0));
  const displayWidth = Math.max(1, Math.round(display.width));
  const displayHeight = Math.max(1, Math.round(display.height));
  return {
    width: Math.min(safeWidth, displayWidth),
    height: Math.min(safeHeight, displayHeight),
  };
}

function resolveMainWindowDisplay(layout, viewport) {
  const fallback = {
    left: 0,
    top: 0,
    width: Math.max(1, Math.round(viewport?.width || 1280)),
    height: Math.max(1, Math.round(viewport?.height || 900)),
    source: 'main-screen-fallback',
    screenIndex: null,
  };
  const mainScreen = layout?.screens?.find(screen => screen.isMain);
  if (!mainScreen?.visible) return fallback;

  const main = layout.main || mainScreen.frame;
  const mainMaxY = main ? main.y + main.height : null;
  if (!Number.isFinite(mainMaxY)) return fallback;

  return {
    left: mainScreen.visible.x,
    top: mainMaxY - mainScreen.visible.y - mainScreen.visible.height,
    width: mainScreen.visible.width,
    height: mainScreen.visible.height,
    source: 'macos-main-visible-frame',
    screenIndex: mainScreen.index,
  };
}

function centeredWindowBounds(viewport, display) {
  const windowSize = fitWindowToDisplay(viewport?.width || 1280, viewport?.height || 900, display);
  return {
    left: Math.round(display.left + (display.width - windowSize.width) / 2),
    top: Math.round(display.top + (display.height - windowSize.height) / 2),
    width: windowSize.width,
    height: windowSize.height,
  };
}

function isWindowFullyContained(bounds, display) {
  const tolerance = 2;
  return Number.isFinite(bounds?.left)
    && Number.isFinite(bounds?.top)
    && Number.isFinite(bounds?.width)
    && Number.isFinite(bounds?.height)
    && bounds.left >= display.left - tolerance
    && bounds.top >= display.top - tolerance
    && bounds.left + bounds.width <= display.left + display.width + tolerance
    && bounds.top + bounds.height <= display.top + display.height + tolerance;
}

async function placeBackgroundWindowOnDisplay(session, targetId, viewport, displayTarget, assertFocusAllowed = () => {}) {
  const layout = await queryMacScreenLayout();
  assertFocusAllowed();
  if (!layout) throw new Error('无法读取显示器布局，停止窗口定位');
  const normalizedTarget = normalizeDisplayTarget(displayTarget);
  const mainDisplay = resolveMainWindowDisplay(layout, viewport);
  const display = resolveVisibleDisplayBounds(layout, normalizedTarget, mainDisplay);
  const requestedBounds = centeredWindowBounds(viewport, display);
  const { windowId } = await session.send('Browser.getWindowForTarget', { targetId });
  assertFocusAllowed();
  const { bounds: currentBounds } = await session.send('Browser.getWindowBounds', { windowId });
  assertFocusAllowed();
  // 创建新页签时通常复用同一个窗口；不要重复切换已正常定位的原生窗口状态。
  const alreadyPlaced = currentBounds?.windowState === 'normal'
    && Object.entries(requestedBounds).every(([key, value]) => currentBounds[key] === value);
  let bounds = currentBounds;
  if (!alreadyPlaced) {
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { ...requestedBounds, windowState: 'normal' },
    });
    assertFocusAllowed();
    ({ bounds } = await session.send('Browser.getWindowBounds', { windowId }));
    assertFocusAllowed();
  }
  if (bounds.windowState !== 'normal' || !isWindowFullyContained(bounds, display)) {
    throw new Error(`测试 Edge 窗口未完全位于目标显示器可用区域：${JSON.stringify({ bounds, display })}`);
  }
  return {
    mode: 'background-visible-no-focus',
    visible: true,
    hidden: false,
    centered: true,
    displayTarget: normalizedTarget,
    source: display.source,
    screenIndex: display.screenIndex,
    windowState: bounds.windowState,
    bounds: {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    },
  };
}

async function centerVisibleWindow(context, { viewport, displayTarget = 'secondary', verifyPlacement = false } = {}) {
  const normalizedTarget = normalizeDisplayTarget(displayTarget);
  const page = context.pages()[0] || await context.newPage();
  let pageSession;
  let browserSession;
  try {
    const current = await page.evaluate(() => ({
      screen: {
        left: Number(window.screen.availLeft),
        top: Number(window.screen.availTop),
        width: Number(window.screen.availWidth),
        height: Number(window.screen.availHeight),
      },
      outerWidth: Number(window.outerWidth),
      outerHeight: Number(window.outerHeight),
    }));
    const layout = await queryMacScreenLayout();
    const display = resolveVisibleDisplayBounds(layout, normalizedTarget, current.screen);
    if (verifyPlacement && normalizedTarget === 'secondary'
        && (display.source !== 'macos-nsscreen' || selectMacDisplay(layout, normalizedTarget)?.isMain !== false)) {
      throw new Error('无法确认第二块显示器的可用区域，停止前台隔离窗口定位');
    }
    const windowSize = fitWindowToDisplay(
      viewport?.width || current.outerWidth || 1280,
      viewport?.height || current.outerHeight || 900,
      display,
    );
    const left = Math.round(display.left + (display.width - windowSize.width) / 2);
    const top = Math.round(display.top + (display.height - windowSize.height) / 2);

    pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const browser = context.browser();
    if (!browser) throw new Error('无法获取可见隔离 Edge 实例');
    browserSession = await browser.newBrowserCDPSession();
    const { windowId } = await browserSession.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId,
    });
    await browserSession.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left, top, width: windowSize.width, height: windowSize.height, windowState: 'normal' },
    });
    let observedBounds;
    if (verifyPlacement) {
      ({ bounds: observedBounds } = await browserSession.send('Browser.getWindowBounds', { windowId }));
      if (observedBounds?.windowState !== 'normal' || !isWindowFullyContained(observedBounds, display)) {
        throw new Error(`前台隔离 Edge 窗口未完全位于目标显示器可用区域：${JSON.stringify({ bounds: observedBounds, display })}`);
      }
    }

    return {
      mode: 'headed-centered',
      centered: true,
      displayTarget: normalizedTarget,
      source: display.source,
      screenIndex: display.screenIndex,
      bounds: observedBounds ? {
        left: observedBounds.left, top: observedBounds.top, width: observedBounds.width, height: observedBounds.height,
      } : { left, top, width: windowSize.width, height: windowSize.height },
    };
  } finally {
    await browserSession?.detach().catch(() => {});
    await pageSession?.detach().catch(() => {});
  }
}

function findMacAppBundle(browserPath) {
  let current = path.resolve(browserPath);
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

async function waitForDevToolsPort(profileDir, timeout) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Edge 仍在启动；继续轮询专用 profile 内的端口文件。
    }
    await delay(50);
  }
  throw new Error(`后台 Edge 未在 ${timeout}ms 内写入 DevToolsActivePort`);
}

async function connectWithRetry(chromium, endpoint, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint, {
        timeout: Math.min(1500, Math.max(deadline - Date.now(), 1)),
        isLocal: true,
      });
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error(`无法连接后台 Edge：${endpoint}`);
}

async function closeUnacquiredBrowserConnection(browser) {
  // Keep the original helper's 1500ms transport bound; expiry is an error,
  // never a PID-gone receipt and never authority to remove an unknown profile.
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => browser.close()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Unacquired CDP connection close timed out; retain the profile')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createMacBackgroundSession(browser, context, windowPlacement, { foreground = false } = {}) {
  let connectionClosing;
  let guardedClose;
  let guardedClosing;
  let signalHandling;
  let signalsRouted = false;
  const session = {
    context,
    launchMode: foreground ? 'macos-foreground-cdp' : 'macos-background-cdp',
    focusPolicy: foreground ? 'foreground-authorized' : 'launchservices-no-foreground',
    windowPlacement,
    close: closeBrowserConnection,
    closeBrowserConnection,
    useGuardedClose,
  };
  function closeBrowserConnection() {
    connectionClosing ||= (async () => {
      await browser.close();
    })();
    return connectionClosing;
  }
  function releaseSignalHandlers() {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    signalsRouted = false;
  }
  function closeGuardedBrowser() {
    if (!guardedClosing) {
      const handler = guardedClose;
      guardedClosing = Promise.resolve().then(() => handler.call(session)).finally(releaseSignalHandlers);
    }
    return guardedClosing;
  }
  function useGuardedClose(handler) {
    if (typeof handler !== 'function') throw new TypeError('Guarded close must be a function');
    // Re-registering our wrapper must not turn its delegate into itself.
    if (handler !== closeGuardedBrowser) guardedClose = handler;
    session.close = closeGuardedBrowser;
    if (!signalsRouted && !guardedClosing) {
      signalsRouted = true;
      process.on('SIGINT', handleSigint);
      process.on('SIGTERM', handleSigterm);
    }
  }
  function handleSignal(exitCode) {
    signalHandling ||= (async () => {
      try {
        // Resolve the delegate at signal time; never retain the original close.
        await session.close();
      } catch (error) {
        console.error('Guarded browser close failed; retain the profile:', error);
      } finally {
        process.exit(exitCode);
      }
    })();
    return signalHandling;
  }
  function handleSigint() { void handleSignal(130); }
  function handleSigterm() { void handleSignal(143); }
  return session;
}

async function launchFocusSafePersistentContext({
  chromium,
  profileDir,
  browserPath,
  headless,
  background,
  browserArgs = [],
  viewport,
  displayTarget = 'secondary',
  timeout = 30000,
}) {
  if (background && !headless && process.platform !== 'darwin') {
    throw new Error('不抢焦点的可见后台窗口目前只支持 macOS；请显式使用 --headed 或 --headless');
  }
  const nativeAppBundle = process.platform === 'darwin' && !headless && typeof browserPath === 'string'
    ? findMacAppBundle(browserPath) : null;
  // Keep the ordinary SDK contract for headless, other platforms and non-app
  // executables. A visible macOS .app uses native launch; failures never fallback.
  if (!(process.platform === 'darwin' && !headless && (background || nativeAppBundle))) {
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browserPath,
      headless,
      args: browserArgs,
      viewport,
    });
    let windowPlacement;
    try {
      windowPlacement = !background && !headless
        ? await centerVisibleWindow(context, { viewport, displayTarget })
        : null;
    } catch (originalError) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => context.close()),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const closeError = new Error('Context close after window centering failure timed out');
              closeError.code = 'CONTEXT_CLOSE_TIMEOUT';
              reject(closeError);
            }, 1500);
          }),
        ]);
      } catch (closeError) {
        throw new AggregateError([originalError, closeError], 'Window centering failed; context close also failed; first error is primary', { cause: originalError });
      } finally {
        clearTimeout(timer);
      }
      throw originalError;
    }
    return {
      context,
      launchMode: headless ? 'playwright-headless' : 'playwright-headed',
      focusPolicy: headless ? 'headless' : 'foreground-authorized',
      windowPlacement,
      close: () => context.close(),
    };
  }

  const appBundle = nativeAppBundle;
  if (!appBundle || !fs.existsSync(appBundle)) {
    throw new Error(`无法从浏览器路径定位 macOS .app：${browserPath}；为避免抢占前台焦点，后台测试已停止`);
  }

  // A lock is only a reuse sentinel, never a PID or signal authority.
  if (fs.lstatSync(path.join(profileDir, 'SingletonLock'), { throwIfNoEntry: false })) {
    throw new Error(`专用测试 profile 已有 SingletonLock；身份未知，保留目录并停止：${profileDir}`);
  }

  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const windowSize = `${viewport?.width || 1280},${viewport?.height || 900}`;
  if (browserArgs.some(argument => argument === '--start-minimized')) {
    throw new Error('后台测试禁止最小化窗口；请让 helper 把窗口完整放在目标显示器可用区域内');
  }
  const macBackgroundArgs = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--enable-automation',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-startup-window',
    `--window-size=${windowSize}`,
    ...browserArgs.filter(argument => !argument.startsWith('--window-position=')),
  ];

  let browser;
  let guardedSession;
  let browserPid;
  try {
    const frontmostBefore = background ? await queryMacFrontmostApplication() : null;
    await execFileAsync('/usr/bin/open', [...(background ? ['-g'] : []), '-n', '-a', appBundle, '--args', ...macBackgroundArgs]);
    const port = await waitForDevToolsPort(profileDir, timeout);
    browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`, timeout);
    const context = browser.contexts()[0];
    if (!context) throw new Error('后台 Edge 没有可用的持久化浏览器上下文');
    const windowPlacement = {
      mode: background ? 'background-visible-no-focus' : 'headed-native-cdp',
      visible: true,
      hidden: false,
      centered: false,
      windowState: 'normal',
      bounds: null,
    };
    guardedSession = createMacBackgroundSession(browser, context, windowPlacement, { foreground: !background });
    guardBrowserClose(guardedSession, profileDir);
    // Reuse the guard's CDP+OS-verified PID for focus metadata. Await its
    // complete capture: any ownership or detach error must fail launch, while
    // guarded close retains every error and the duty to terminate a known owner.
    browserPid = await getGuardedBrowserPid(guardedSession);
    if (!browserPid) throw new Error('无法确认后台 Edge 的精确进程 ID；为避免误清理其他浏览器，测试已停止');
    if (background) {
      backgroundContexts.set(context, { viewport, displayTarget, browserPid, frontmostBefore, windowPlacement });
      await newPageWithoutForeground(context, timeout);
    } else {
      foregroundNativeContexts.set(context, { viewport: viewport ? { ...viewport } : undefined });
      await newPageWithoutForeground(context, timeout);
      Object.assign(windowPlacement, await centerVisibleWindow(context, { viewport, displayTarget, verifyPlacement: true }));
    }

    return guardedSession;
  } catch (error) {
    try {
      if (guardedSession) {
        // Fulfillment is the shared guard's exact-owner/PID-gone receipt.
        await guardedSession.close();
      } else if (browser) {
        // CDP connected without an actual context: transport only, no receipt.
        await closeUnacquiredBrowserConnection(browser);
      }
      // Before CDP there is no owned session: retain profile, send no signals.
    } catch (closeError) {
      const launchError = new AggregateError([error, closeError], 'Browser launch failed; close failed; retain the profile', { cause: error });
      // CLI reports persist stack only. Retain codes and every nested capture /
      // close error there as well, while keeping the original cause and errors.
      const pending = [error, closeError];
      const seen = new Set();
      const details = [];
      for (let index = 0; index < pending.length; index += 1) {
        const current = pending[index];
        if (seen.has(current)) continue;
        seen.add(current);
        details.push(`${current?.code ? `[${current.code}] ` : ''}${String(current?.stack || current)}`);
        if (Array.isArray(current?.errors)) pending.push(...current.errors);
        if (current?.cause) pending.push(current.cause);
      }
      launchError.stack += `\nGuarded launch errors (retained):\n${details.join('\n')}`;
      throw launchError;
    }
    // No launch failure authorizes profile deletion, even after guarded close.
    throw error;
  }
}

async function newPageWithoutForeground(context, timeout = 10000) {
  if (!backgroundContexts.has(context)) {
    const page = await context.newPage();
    const foreground = foregroundNativeContexts.get(context);
    if (foreground?.viewport) await page.setViewportSize(foreground.viewport);
    return page;
  }

  const browser = context.browser();
  if (!browser) throw Object.assign(new Error('无法获取隔离浏览器实例；为避免抢占前台焦点，已停止创建页面'), {code: 'FOCUS_SAFETY_VIOLATION'});
  const backgroundState = backgroundContexts.get(context);
  if (backgroundState.focusViolation) throw backgroundState.focusViolation;
  const assertFocusAllowed = () => {if (backgroundState.focusViolation) throw backgroundState.focusViolation;};
  // 每次建页都使用新证据，不能沿用上一页成功时的前台状态。
  const focusSafety = {browserPid: backgroundState.browserPid, targetId: null, outcome: 'in-progress', samples: []};
  backgroundState.windowPlacement.focusSafety = focusSafety;
  backgroundState.windowPlacement.browserFrontmost = null;
  backgroundState.windowPlacement.frontmostAfter = null;
  const checkFocus = async stage => {
    if (backgroundState.focusViolation) throw backgroundState.focusViolation;
    const application = await queryMacFrontmostApplication();
    // 并发建页时，一次失败必须阻止其他检查继续写入成功快照。
    if (backgroundState.focusViolation) throw backgroundState.focusViolation;
    focusSafety.samples.push({stage, at: Date.now(), application});
    const browserFrontmost = application ? application.pid === backgroundState.browserPid : null;
    backgroundState.windowPlacement.browserFrontmost = browserFrontmost;
    backgroundState.windowPlacement.frontmostAfter = application;
    if (browserFrontmost !== false) {
      const message = application
        ? `测试 Edge 进程 ${backgroundState.browserPid} 成为了前台应用；测试已停止`
        : '无法读取 macOS 前台应用；为避免测试窗口争抢焦点，测试已停止';
      // 一些调用方只保存 stack；同时保留有界的阶段快照供事后定位。
      backgroundState.windowPlacement.focusSafety = focusSafety;
      focusSafety.outcome = 'focus-violation';
      const error = Object.assign(new Error(`${message}；前台检查记录：${JSON.stringify(focusSafety)}`),
        {code: 'FOCUS_SAFETY_VIOLATION', focusSafety});
      backgroundState.focusViolation = error;
      throw error;
    }
  };
  const markerUrl = `about:blank#fluentread-background-${crypto.randomUUID()}`;
  let targetId, session;
  try {
    session = await browser.newBrowserCDPSession();
    assertFocusAllowed();
    await checkFocus('before-target');
    assertFocusAllowed();
    ({ targetId } = await session.send('Target.createTarget', { url: markerUrl, background: true }));
    focusSafety.targetId = targetId;
    // 若创建页签时已经抢占焦点，不再执行窗口定位。
    await checkFocus('after-target');
    assertFocusAllowed();
    const placement = await placeBackgroundWindowOnDisplay(
      session,
      targetId,
      backgroundState.viewport,
      backgroundState.displayTarget,
      assertFocusAllowed,
    );
    assertFocusAllowed();
    Object.assign(backgroundState.windowPlacement, placement);
    await checkFocus('after-placement');
    assertFocusAllowed();
    backgroundState.windowPlacement.frontmostBefore = backgroundState.frontmostBefore;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const page = context.pages().find(candidate => candidate.url() === markerUrl);
      if (page) {await checkFocus('before-return'); assertFocusAllowed(); focusSafety.outcome = 'complete'; return page;}
      await delay(25);
    }
    throw new Error(`后台页签未在 ${timeout}ms 内进入 Playwright 上下文`);
  } catch (error) {
    // 创建或定位失败时，先前阶段的非前台读数不能当作完整建页成功。
    if (!backgroundState.focusViolation) {
      focusSafety.outcome = 'incomplete';
      backgroundState.windowPlacement.focusSafety = focusSafety;
      backgroundState.windowPlacement.browserFrontmost = null;
      backgroundState.windowPlacement.frontmostAfter = null;
      try {if (error && typeof error === 'object') error.focusSafety = focusSafety;} catch {}
    }
    if (targetId) await session.send('Target.closeTarget', { targetId }).catch(() => {});
    throw error;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

async function activateExtensionTabWithoutForeground(context, page, timeout = 10000) {
  if (page.url().startsWith('chrome-extension://')) {
    await page.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (!tab?.id) throw new Error('无法获取当前扩展测试页签');
      await chrome.tabs.update(tab.id, { active: true });
    });
    return;
  }

  let workers = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension://'));
  if (workers.length === 0) {
    workers = [await context.waitForEvent('serviceworker', { timeout })];
  }
  const pageUrl = page.url();
  await workers[0].evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(candidate => candidate.url === url);
    if (!tab?.id) throw new Error(`找不到待激活的隔离测试页签：${url}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, pageUrl);
}

// 诊断端口独立注册原生事件；保持已有浏览器启动与 Target 创建逻辑不变。
function startFocusEventMonitor(options) {return require('./mac-focus-event-monitor.cjs').startFocusEventMonitor(options);}
module.exports = {
  startFocusEventMonitor,
  queryMacFrontmostApplication,
  activateExtensionTabWithoutForeground,
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
};
