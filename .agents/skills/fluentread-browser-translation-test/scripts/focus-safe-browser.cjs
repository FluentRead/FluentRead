'use strict';

/**
 * Shared local FluentRead browser test helper. Background window placement
 * prefers DeskPad, then a secondary display, then the primary display.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { guardBrowserClose, getGuardedBrowserPid } = require('./owned-browser-close.cjs');

const execFileAsync = promisify(execFile);
const backgroundContexts = new WeakMap();
const deskPadDisplayName = 'DeskPad Display';
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
  '  const displayId = Number(ObjC.unwrap(screen.deviceDescription.objectForKey("NSScreenNumber")));',
  '  const displayName = ObjC.unwrap(screen.localizedName);',
  '  result.push({ index, frame, visible, isMain: index === 0, displayId, displayName });',
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
  const raw = String(displayTarget).trim();
  const value = raw.toLowerCase();
  if (value.startsWith('name:')) {
    const name = raw.slice(5).trim();
    if (!name) throw new Error('name: 后必须指定显示器的完整名称');
    return `name:${name}`;
  }
  if (value === 'current' || value === 'active' || value === 'auto') return 'current';
  if (value === 'secondary' || value === 'second') return 'secondary';
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : 'secondary';
}

function isNamedDisplay(displayTarget) {
  return typeof displayTarget === 'string' && displayTarget.startsWith('name:');
}

function resolveBackgroundDisplayTarget(requestedDisplay) {
  const configuredDisplay = process.env.FLUENTREAD_TEST_DISPLAY?.trim();
  const target = normalizeDisplayTarget(configuredDisplay || requestedDisplay);
  if (configuredDisplay && !isNamedDisplay(target)) {
    throw new Error('FLUENTREAD_TEST_DISPLAY 必须使用 name:<显示器完整名称>');
  }
  return target;
}

function selectMacDisplay(layout, displayTarget) {
  if (isNamedDisplay(displayTarget)) {
    const matches = layout?.screens.filter(screen => screen.displayName === displayTarget.slice(5));
    const screen = matches?.length === 1 ? matches[0] : null;
    if (screen?.isMain !== false || !Number.isInteger(screen.displayId) || screen.displayId <= 0) {
      const guidance = displayTarget === `name:${deskPadDisplayName}`
        ? '请打开 DeskPad 并确认 DeskPad Display 已连接'
        : '请检查显示器名称和连接状态';
      throw new Error(`无法确认唯一的扩展显示器 ${displayTarget}。${guidance}`);
    }
    return screen;
  }
  if (!layout?.screens?.length || displayTarget === 'current') return null;
  if (Number.isInteger(displayTarget)) {
    return layout.screens.find(screen => screen.index === displayTarget) || null;
  }
  return layout.screens.find(screen => !screen.isMain) || layout.screens[0];
}

function macVisibleBounds(layout, screen) {
  const main = layout?.main || layout?.screens.find(screen => screen.isMain)?.frame;
  const mainMaxY = main ? main.y + main.height : null;
  const { x, y, width, height } = screen?.visible ?? {};
  if (![x, y, width, height, mainMaxY].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    // NSScreen uses a bottom-left origin; Chromium window bounds use the
    // top-left virtual-desktop origin. Convert only the vertical coordinate.
    left: x,
    top: mainMaxY - y - height,
    width,
    height,
    source: 'macos-nsscreen',
    screenIndex: screen.index,
    displayId: screen.displayId,
    displayName: screen.displayName,
  };
}

function resolveVisibleDisplayBounds(layout, displayTarget, currentScreen) {
  const display = macVisibleBounds(layout, selectMacDisplay(layout, displayTarget));
  if (display) return display;
  if (isNamedDisplay(displayTarget)) throw new Error(`无法读取显示器 ${displayTarget} 的可用区域`);
  const {left, top, width, height} = currentScreen;
  return {left, top, width, height, source: 'browser-current-screen', screenIndex: null};
}

function defaultBackgroundDisplays(layout) {
  if (!layout) throw new Error('无法读取 macOS 显示器布局，停止窗口定位');
  const deskPads = layout.screens.filter(screen => screen.displayName === deskPadDisplayName);
  const candidates = [
    {screen: deskPads.length === 1 && !deskPads[0].isMain ? deskPads[0] : null, role: 'deskpad'},
    ...layout.screens
      .filter(screen => !screen.isMain && screen.displayName !== deskPadDisplayName)
      .map(screen => ({screen, role: 'secondary'})),
    {screen: layout.screens.find(screen => screen.isMain), role: 'primary'},
  ];
  const available = [];
  for (const {screen, role} of candidates) {
    const display = macVisibleBounds(layout, screen);
    if (display && Number.isInteger(display.displayId) && display.displayId > 0) {
      available.push({...display, role});
    }
  }
  if (!available.length) throw new Error('没有可验证的显示器可用区域，停止窗口定位');
  return available;
}

async function readNamedDisplay(displayTarget, expectedDisplayId) {
  const display = resolveVisibleDisplayBounds(await queryMacScreenLayout(), displayTarget, null);
  if (expectedDisplayId !== undefined && display.displayId !== expectedDisplayId) {
    throw new Error(`显示器 ${displayTarget} 在测试期间重新连接，请重新启动测试`);
  }
  return display;
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
    && bounds.width > 0
    && bounds.height > 0
    && bounds.left >= display.left - tolerance
    && bounds.top >= display.top - tolerance
    && bounds.left + bounds.width <= display.left + display.width + tolerance
    && bounds.top + bounds.height <= display.top + display.height + tolerance;
}

async function placeBackgroundWindowOnDisplay(session, targetId, state, {assertFocusAllowed, checkFocus, initialWindow}) {
  const { viewport, displayTarget, displayId } = state;
  const layout = await queryMacScreenLayout();
  assertFocusAllowed();
  if (!layout) throw new Error('无法读取显示器布局，停止窗口定位');
  const automatic = displayTarget === 'secondary';
  const candidates = automatic ? defaultBackgroundDisplays(layout) : [
    resolveVisibleDisplayBounds(layout, displayTarget, resolveMainWindowDisplay(layout, viewport)),
  ];
  if (displayId !== undefined && candidates[0].displayId !== displayId) {
    throw new Error(`显示器 ${displayTarget} 在测试期间重新连接，请重新启动测试`);
  }
  const { windowId } = await session.send('Browser.getWindowForTarget', { targetId });
  assertFocusAllowed();
  const { bounds: currentBounds } = await session.send('Browser.getWindowBounds', { windowId });
  assertFocusAllowed();
  const firstChoice = candidates[0];
  if (initialWindow && !automatic
      && (currentBounds?.windowState !== 'normal' || !isWindowFullyContained(currentBounds, firstChoice))) {
    throw new Error(`隔离 Edge 初始窗口未在指定显示器内：${JSON.stringify({ bounds: currentBounds, display: firstChoice })}`);
  }
  let bounds = currentBounds;
  const failedPlacements = [];
  for (const display of candidates) {
    const requestedBounds = centeredWindowBounds(viewport, display);
    const alreadyPlaced = bounds?.windowState === 'normal'
      && Object.entries(requestedBounds).every(([key, value]) => bounds[key] === value);
    let moveError;
    if (!alreadyPlaced) {
      try {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { ...requestedBounds, windowState: 'normal' },
        });
      } catch (error) {
        if (!automatic) throw error;
        moveError = error;
      }
      assertFocusAllowed();
      // A failed CDP read aborts the run. Falling back requires a verifiable window.
      ({ bounds } = await session.send('Browser.getWindowBounds', { windowId }));
      assertFocusAllowed();
    }
    if (moveError || bounds?.windowState !== 'normal' || !isWindowFullyContained(bounds, display)) {
      failedPlacements.push({displayName: display.displayName, role: display.role, bounds,
        reason: moveError?.message ?? '窗口未完整位于显示器可用区域'});
      if (automatic) await checkFocus('after-failed-placement');
      continue;
    }
    return {
      mode: 'background-visible-no-focus',
      visible: true,
      hidden: false,
      centered: true,
      displayTarget,
      displayRole: display.role ?? 'explicit',
      failedPlacements,
      source: display.source,
      screenIndex: display.screenIndex,
      displayId: display.displayId,
      displayName: display.displayName,
      ...initialWindow ? { initialBounds: currentBounds } : {},
      windowState: bounds.windowState,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    };
  }
  throw new Error(`未能将隔离 Edge 窗口完整放到可用显示器：${JSON.stringify(failedPlacements)}`);
}

async function centerVisibleWindow(context, { viewport, displayTarget = 'secondary' } = {}) {
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
    return {
      mode: 'headed-centered',
      centered: true,
      displayTarget: normalizedTarget,
      source: display.source,
      screenIndex: display.screenIndex,
      displayId: display.displayId,
      displayName: display.displayName,
      bounds: { left, top, width: windowSize.width, height: windowSize.height },
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

function createMacBackgroundSession(browser, context, windowPlacement) {
  let connectionClosing;
  let guardedClose;
  let guardedClosing;
  let signalHandling;
  let signalsRouted = false;
  const session = {
    context,
    launchMode: 'macos-background-cdp',
    focusPolicy: 'launchservices-no-foreground',
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
  if (!background || headless) {
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

  const appBundle = typeof browserPath === 'string' ? findMacAppBundle(browserPath) : null;
  if (!appBundle || !fs.existsSync(appBundle)) {
    throw new Error(`无法从浏览器路径定位 macOS .app：${browserPath}；为避免抢占前台焦点，后台测试已停止`);
  }

  displayTarget = resolveBackgroundDisplayTarget(displayTarget);
  const namedDisplay = isNamedDisplay(displayTarget) ? await readNamedDisplay(displayTarget) : null;
  const startupDisplay = displayTarget === 'secondary'
    ? defaultBackgroundDisplays(await queryMacScreenLayout())[0]
    : namedDisplay;

  // A lock is only a reuse sentinel, never a PID or signal authority.
  if (fs.lstatSync(path.join(profileDir, 'SingletonLock'), { throwIfNoEntry: false })) {
    throw new Error(`专用测试 profile 已有 SingletonLock；身份未知，保留目录并停止：${profileDir}`);
  }

  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  // Target.createTarget's optional bounds are not supported by older Edge builds.
  // Position the first native window at creation, then verify its initial bounds via CDP.
  const startupBounds = startupDisplay && centeredWindowBounds(viewport, startupDisplay);
  const windowSize = startupBounds ? `${startupBounds.width},${startupBounds.height}`
    : `${viewport?.width || 1280},${viewport?.height || 900}`;
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
    ...startupBounds ? [`--window-position=${startupBounds.left},${startupBounds.top}`] : [],
    ...browserArgs.filter(argument => !argument.startsWith('--window-position=')
      && (!startupBounds || !argument.startsWith('--window-size='))),
  ];

  let browser;
  let guardedSession;
  let browserPid;
  try {
    const frontmostBefore = await queryMacFrontmostApplication();
    await execFileAsync('/usr/bin/open', ['-g', '-n', '-a', appBundle, '--args', ...macBackgroundArgs]);
    const port = await waitForDevToolsPort(profileDir, timeout);
    browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`, timeout);
    const context = browser.contexts()[0];
    if (!context) throw new Error('后台 Edge 没有可用的持久化浏览器上下文');
    const windowPlacement = {
      mode: 'background-visible-no-focus',
      visible: true,
      hidden: false,
      centered: false,
      windowState: 'normal',
      bounds: null,
    };
    guardedSession = createMacBackgroundSession(browser, context, windowPlacement);
    guardBrowserClose(guardedSession, profileDir);
    // Reuse the guard's CDP+OS-verified PID for focus metadata. Await its
    // complete capture: any ownership or detach error must fail launch, while
    // guarded close retains every error and the duty to terminate a known owner.
    browserPid = await getGuardedBrowserPid(guardedSession);
    if (!browserPid) throw new Error('无法确认后台 Edge 的精确进程 ID；为避免误清理其他浏览器，测试已停止');
    backgroundContexts.set(context, { viewport, displayTarget, displayId: namedDisplay?.displayId, browserPid, frontmostBefore, windowPlacement });
    await newPageWithoutForeground(context, timeout);

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
  if (!backgroundContexts.has(context)) return context.newPage();

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
    const hasNamedDisplay = backgroundState.displayId !== undefined;
    if (hasNamedDisplay) await readNamedDisplay(backgroundState.displayTarget, backgroundState.displayId);
    await checkFocus('before-target');
    assertFocusAllowed();
    const initialWindow = !backgroundState.windowPlacement.bounds
      && (hasNamedDisplay || backgroundState.displayTarget === 'secondary');
    ({ targetId } = await session.send('Target.createTarget', { url: markerUrl, background: true }));
    focusSafety.targetId = targetId;
    // 若创建页签时已经抢占焦点，不再执行窗口定位。
    await checkFocus('after-target');
    assertFocusAllowed();
    const placement = await placeBackgroundWindowOnDisplay(
      session,
      targetId,
      backgroundState,
      { assertFocusAllowed, checkFocus, initialWindow },
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

async function captureBackgroundDisplay(context, page, outputPath) {
  const state = backgroundContexts.get(context);
  const autoDeskPad = state?.displayTarget === 'secondary' && state.windowPlacement.displayRole === 'deskpad';
  const captureTarget = autoDeskPad ? `name:${deskPadDisplayName}` : state?.displayTarget;
  const displayId = autoDeskPad ? state.windowPlacement.displayId : state?.displayId;
  if (!isNamedDisplay(captureTarget) || displayId === undefined || page.context() !== context) {
    throw new Error('整屏截图需要按名称锁定的隔离显示器。回退到实体屏时使用页面截图');
  }
  async function verifyTarget() {
    if (state.focusViolation) throw state.focusViolation;
    const display = await readNamedDisplay(captureTarget, displayId);
    const session = await context.newCDPSession(page);
    try {
      const { bounds } = await session.send('Browser.getWindowForTarget');
      if (bounds.windowState !== 'normal' || !isWindowFullyContained(bounds, display)) {
        throw new Error(`截图时窗口未完整位于 ${captureTarget}`);
      }
    } finally {
      await session.detach();
    }
    const frontmost = await queryMacFrontmostApplication();
    if (!frontmost || frontmost.pid === state.browserPid) {
      throw new Error('整屏截图时无法确认隔离 Edge 仍在后台');
    }
    return display;
  }

  const display = await verifyTarget();
  const { stdout: png } = await execFileAsync('/usr/bin/swift', [
    path.join(__dirname, 'mac-display-screenshot.swift'), String(display.displayId), display.displayName,
  ], { encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  await verifyTarget();
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('macOS 未返回有效的显示器 PNG');
  }
  await fs.promises.writeFile(outputPath, png);
  return { path: outputPath, displayId: display.displayId, displayName: display.displayName,
    width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// 诊断端口独立注册原生事件；保持已有浏览器启动与 Target 创建逻辑不变。
function startFocusEventMonitor(options) {return require('./mac-focus-event-monitor.cjs').startFocusEventMonitor(options);}
module.exports = {
  startFocusEventMonitor,
  queryMacFrontmostApplication,
  activateExtensionTabWithoutForeground,
  captureBackgroundDisplay,
  resolveBackgroundDisplayTarget,
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
};
