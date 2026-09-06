'use strict';

/**
 * Popup 启动首帧回归 runner。
 *
 * 这个脚本只通过真实的扩展页和后台 runtime 消息工作：它在 Popup 文档的
 * document_start 阶段延迟 configStorageRead，并在每个 requestAnimationFrame
 * 和 MutationObserver 回调中采样第一块可见 .popup-shell。这样可以区分
 * “配置已经生效后的最终截图”和“配置读取期间已经被用户看到的旧 UI”。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(argument(
  'playwright-root',
  '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules',
));
const focusHelper = path.resolve(argument(
  'focus-safe-helper',
  '/Users/thinkstu/.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs',
));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-popup-startup-ui'));
const browserPath = argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const timeout = Number(argument('timeout', '30000'));
const configDelayMs = Math.max(250, Number(argument('config-delay-ms', '1400')) || 1400);
const openCount = Math.max(2, Number(argument('opens', '3')) || 3);
const requestedSkin = argument('skin', 'emoji');
const expectFlash = hasFlag('expect-flash');

if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
  throw new Error(`扩展产物不存在：${extensionDir}`);
}
if (!fs.existsSync(focusHelper)) throw new Error(`防抢焦点 helper 不存在：${focusHelper}`);
if (!Number.isFinite(timeout) || timeout < 1000) throw new Error(`timeout 无效：${timeout}`);
fs.mkdirSync(artifactsDir, {recursive: true});

const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
} = require(focusHelper);

const CONFIG_REVISION_FIELD = '__fluentConfigRevision';
const TEST_CLIENT_ID = `popup-startup-${process.pid}-${Date.now()}`;
const MODULE_ORDER = ['quickFeatures', 'translation', 'siteRule', 'footer'];
const QUICK_FEATURE_ORDER = ['document', 'hover', 'selection', 'appearance', 'video', 'image', 'area'];

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function serializableError(error) {
  return error instanceof Error
    ? {message: error.message, stack: error.stack}
    : {message: String(error)};
}

function fileNamePart(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'case';
}

async function writeJson(file, value) {
  const target = path.join(artifactsDir, file);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
  return target;
}

async function screenshot(page, file) {
  const target = path.join(artifactsDir, file);
  await page.screenshot({path: target, fullPage: false});
  return target;
}

function attachDiagnostics(page, errors) {
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
}

async function extensionWorker(context, timeoutMs) {
  const existing = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', {
    timeout: timeoutMs,
    predicate: worker => worker.url().startsWith('chrome-extension://'),
  });
}

function startupProbeScript() {
  return ({delayMs, failFirstRead, holdFirstPersistResponse}) => {
    const state = {
      startedAt: performance.now(),
      configReadRequests: 0,
      configReadReleased: 0,
      configReadDelayMs: 0,
      configReadFailures: 0,
      storageReadKeys: [],
      persistConfigRequests: 0,
      persistConfigModes: [],
      persistConfigResponses: 0,
      persistConfigSuccesses: 0,
      persistConfigResponseHolds: 0,
      persistConfigBatchRequests: 0,
      persistConfigBatchSizes: [],
      renderMutations: 0,
      mountCount: 0,
      frameCount: 0,
      frames: [],
      firstVisibleShell: null,
      lastVisibleShell: null,
    };
    globalThis.__fluentReadPopupStartup = state;

    const originalSendMessage = globalThis.chrome?.runtime?.sendMessage;
    if (typeof originalSendMessage === 'function') {
      const original = originalSendMessage.bind(globalThis.chrome.runtime);
      const delayedSendMessage = function delayedSendMessage(...args) {
        const message = [args[0], args[1]].find(value => (
          value && typeof value === 'object' && typeof value.type === 'string'
        ));
        if (message?.type === 'persistConfig') {
          state.persistConfigRequests += 1;
          state.persistConfigModes.push(message.mode || 'replace');
          const shouldHoldResponse = holdFirstPersistResponse && state.persistConfigRequests === 1;
          const recordResponse = response => {
            state.persistConfigResponses += 1;
            if (response?.success === true) state.persistConfigSuccesses += 1;
          };
          const callbackIndex = args.findLastIndex(argument => typeof argument === 'function');
          if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = response => {
              recordResponse(response);
              if (shouldHoldResponse) state.persistConfigResponseHolds += 1;
              else callback(response);
            };
          }
          const result = original(...args);
          if (callbackIndex < 0) {
            return Promise.resolve(result).then(response => {
              recordResponse(response);
              if (shouldHoldResponse) {
                state.persistConfigResponseHolds += 1;
                return new Promise(() => {});
              }
              return response;
            });
          }
          return result;
        }
        if (message?.type === 'persistConfigBatch') {
          state.persistConfigBatchRequests += 1;
          state.persistConfigBatchSizes.push(message.patches?.length || 0);
          return original(...args);
        }
        if (message?.type === 'configStorageRead') state.storageReadKeys.push(message.key);
        if (message?.type !== 'configStorageRead' || message.key !== 'local:config') return original(...args);
        state.configReadRequests += 1;
        const requestedAt = performance.now();
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            state.configReadReleased += 1;
            state.configReadDelayMs = Math.max(state.configReadDelayMs, performance.now() - requestedAt);
            if (failFirstRead && message.key === 'local:config' && state.configReadFailures === 0) {
              state.configReadFailures += 1;
              const failure = {success: false, error: 'popup-startup-test: injected local:config read failure'};
              const callback = args.findLast(argument => typeof argument === 'function');
              if (callback) callback(failure);
              resolve(failure);
              return;
            }
            Promise.resolve(original(...args)).then(resolve, reject);
          }, delayMs);
        });
      };
      try {
        try {
          Object.defineProperty(globalThis.chrome.runtime, 'sendMessage', {
            configurable: true,
            writable: true,
            value: delayedSendMessage,
          });
        } catch {
          globalThis.chrome.runtime.sendMessage = delayedSendMessage;
        }
        state.delayHookInstalled = globalThis.chrome.runtime.sendMessage === delayedSendMessage;
      } catch (error) {
        state.delayHookInstalled = false;
        state.delayHookError = String(error);
      }
    } else {
      state.delayHookInstalled = false;
      state.delayHookError = 'chrome.runtime.sendMessage 不可用';
    }

    let lastShell;
    const visibleShell = (source) => {
      const shell = document.querySelector('.popup-shell');
      if (!shell) return;
      if (shell !== lastShell) {
        state.mountCount += 1;
        lastShell = shell;
      }
      const rect = shell.getBoundingClientRect();
      const style = getComputedStyle(shell);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none'
        || style.visibility === 'hidden' || Number(style.opacity) <= 0) return;
      const root = document.documentElement;
      const frame = {
        source,
        atMs: Number((performance.now() - state.startedAt).toFixed(3)),
        width: Number(rect.width.toFixed(3)),
        height: Number(rect.height.toFixed(3)),
        skin: shell.getAttribute('data-interface-skin') || '',
        dark: root.classList.contains('dark'),
        ready: shell.getAttribute('data-config-ready') === 'true',
        configReady: shell.getAttribute('data-config-ready') || '',
        ariaBusy: shell.getAttribute('aria-busy') || '',
        moduleOrder: shell.getAttribute('data-popup-module-order') || '',
        quickFeatureOrder: shell.getAttribute('data-popup-quick-feature-order') || '',
        visibleQuickFeatures: shell.getAttribute('data-popup-quick-features') || '',
        popupHeight: root.dataset.popupHeight || '',
        className: shell.className,
      };
      state.frameCount += 1;
      state.frames.push(frame);
      if (state.frames.length > 250) state.frames.shift();
      state.lastVisibleShell = frame;
      if (!state.firstVisibleShell) state.firstVisibleShell = frame;
    };

    const observe = source => visibleShell(source);
    new MutationObserver((records) => {
      state.renderMutations += records.length;
      observe('mutation');
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'class', 'data-interface-skin', 'data-config-ready', 'data-popup-module-order',
        'data-popup-quick-feature-order', 'data-popup-quick-features', 'aria-busy',
      ],
    });
    document.addEventListener('DOMContentLoaded', () => observe('domcontentloaded'), {once: true});
    const sampleFrame = () => {
      observe('requestAnimationFrame');
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
    observe('document-start');
  };
}

async function installStartupProbe(page, options = {}) {
  await page.addInitScript(startupProbeScript(), {
    delayMs: options.delayMs ?? configDelayMs,
    failFirstRead: options.failFirstRead === true,
    holdFirstPersistResponse: options.holdFirstPersistResponse === true,
  });
}

async function readStartupState(page) {
  return page.evaluate(() => globalThis.__fluentReadPopupStartup || null);
}

async function readConfig(page, timeoutMs) {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!response || response.success !== true || !response.value || typeof response.value !== 'object') {
      throw new Error(`后台配置读取失败：${response?.error || '没有返回有效配置'}`);
    }
    return response.value;
  }, undefined, {timeout: timeoutMs});
}

async function patchConfig(page, patch, sequence, timeoutMs) {
  const current = await readConfig(page, timeoutMs);
  const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
  const baseRevision = Number.isSafeInteger(current[CONFIG_REVISION_FIELD])
    ? current[CONFIG_REVISION_FIELD]
    : 0;
  const result = await page.evaluate(async payload => {
    return chrome.runtime.sendMessage({
      type: 'persistConfig',
      mode: 'patch',
      config: payload.patch,
      expected: payload.expected,
      clientId: payload.clientId,
      sequence: payload.sequence,
      baseRevision: payload.baseRevision,
    });
  }, {patch, expected, clientId: TEST_CLIENT_ID, sequence, baseRevision});
  if (!result || result.success !== true) throw new Error(`后台配置 patch 失败：${result?.error || '无响应'}`);
  const deadline = Date.now() + timeoutMs;
  let saved;
  while (Date.now() < deadline) {
    saved = await readConfig(page, timeoutMs);
    const matches = Object.entries(patch).every(([key, value]) => JSON.stringify(saved[key]) === JSON.stringify(value));
    if (matches) return {revision: saved[CONFIG_REVISION_FIELD] ?? result.revision ?? 0, current: saved};
    await delay(60);
  }
  throw new Error(`配置 patch 已响应但回读未达到目标值：${JSON.stringify(Object.keys(patch))}`);
}

function summarizeConfig(config) {
  return {
    revision: config?.[CONFIG_REVISION_FIELD] ?? 0,
    on: config?.on,
    theme: config?.theme,
    interfaceSkin: config?.interfaceSkin,
    popupModuleOrder: config?.popupModuleOrder,
    popupQuickFeatureOrder: config?.popupQuickFeatureOrder,
    interfaceVisibility: config?.interfaceVisibility,
    uiLanguageSetupCompleted: config?.uiLanguageSetupCompleted,
  };
}

function assertManifest(manifest) {
  const popup = manifest?.action?.default_popup || manifest?.browser_action?.default_popup;
  const options = manifest?.options_page || manifest?.options_ui?.page;
  if (typeof popup !== 'string' || !popup) throw new Error('manifest 缺少有效 action.default_popup');
  if (typeof options !== 'string' || !options) throw new Error('manifest 缺少有效 options_page/options_ui.page');
  return {popup, options};
}

async function runPopupCase({
  context,
  extensionOrigin,
  popupPath,
  theme,
  caseIndex,
  report,
  failureMode = false,
  delayMs = configDelayMs,
  enforceFlash = true,
}) {
  const caseName = `${theme}-${caseIndex}`;
  const page = await newPageWithoutForeground(context, timeout);
  attachDiagnostics(page, report.consoleErrors);
  await installStartupProbe(page, {failFirstRead: failureMode, delayMs});
  await page.setViewportSize({width: 400, height: 600});
  const popupUrl = new URL(popupPath, `${extensionOrigin}/`);
  popupUrl.searchParams.set('startupCase', caseName);
  await page.goto(popupUrl.toString(), {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await page.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const startup = await readStartupState(page);
  if (!startup) throw new Error(`${caseName} 没有取得 document_start 首帧状态`);
  if (!failureMode && !expectFlash) {
    if (startup.storageReadKeys.some(key => key === 'local:configHistory' || key === 'session:credentials')) {
      throw new Error(`${caseName} 首屏读取了非必要历史或旧会话凭据：${startup.storageReadKeys}`);
    }
  }
  const readSettleDeadline = Date.now() + Math.max(1000, delayMs + 3000);
  while (Date.now() < readSettleDeadline) {
    if (startup.configReadRequests > 0 && startup.configReadReleased >= startup.configReadRequests) break;
    await delay(100);
    Object.assign(startup, await readStartupState(page));
  }
  if (!startup.delayHookInstalled || startup.configReadRequests < 1
    || startup.configReadReleased < 1
    || (delayMs > 0 && startup.configReadDelayMs < delayMs * .65)) {
    throw new Error(`${caseName} 配置读取延迟没有可靠生效：${JSON.stringify({
      delayHookInstalled: startup.delayHookInstalled,
      configReadRequests: startup.configReadRequests,
      configReadReleased: startup.configReadReleased,
      configReadDelayMs: startup.configReadDelayMs,
      delayMs,
      hookError: startup.delayHookError,
    })}`);
  }
  const shell = page.locator('.popup-shell');
  await shell.waitFor({state: 'visible', timeout});
  await page.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  Object.assign(startup, await readStartupState(page));
  const finalFrame = startup.lastVisibleShell;
  const firstFrame = startup.firstVisibleShell;
  const expectedDark = await page.evaluate(theme => (
    theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ), theme);
  const expected = {
    skin: requestedSkin,
    dark: expectedDark,
    moduleOrder: MODULE_ORDER.join(','),
    quickFeatureOrder: QUICK_FEATURE_ORDER.join(','),
    ready: true,
  };
  if (!firstFrame || !finalFrame) throw new Error(`${caseName} 没有可见 Popup shell 帧`);
  const flashObserved = firstFrame.ready !== expected.ready
    || firstFrame.skin !== expected.skin
    || firstFrame.dark !== expected.dark
    || firstFrame.moduleOrder !== expected.moduleOrder
    || firstFrame.quickFeatureOrder !== expected.quickFeatureOrder;
  if (failureMode) {
    if (startup.configReadFailures !== 1 || !finalFrame.ready || finalFrame.width <= 0) {
      throw new Error(`${caseName} 配置读取失败降级后没有在有限时间内渲染 Popup：${JSON.stringify({
        configReadFailures: startup.configReadFailures,
        firstFrame,
        finalFrame,
      })}`);
    }
  } else if (expectFlash && enforceFlash) {
    if (!flashObserved) throw new Error(`${caseName} 旧版本未观察到预期的默认 UI 首帧：${JSON.stringify(firstFrame)}`);
  } else if (flashObserved && enforceFlash) {
    throw new Error(`${caseName} 新版本仍出现旧 UI 首帧：${JSON.stringify({firstFrame, expected})}`);
  }
  if (!failureMode && (finalFrame.skin !== expected.skin || finalFrame.dark !== expected.dark
    || finalFrame.moduleOrder !== expected.moduleOrder
    || finalFrame.quickFeatureOrder !== expected.quickFeatureOrder
    || !finalFrame.ready || finalFrame.width <= 0 || finalFrame.width > 400)) {
    throw new Error(`${caseName} 最终 Popup shell 配置或尺寸异常：${JSON.stringify({finalFrame, expected})}`);
  }
  const firstCorrectFrame = startup.frames.find(frame => (
    frame.skin === expected.skin
    && frame.dark === expected.dark
    && frame.moduleOrder === expected.moduleOrder
    && frame.quickFeatureOrder === expected.quickFeatureOrder
    && frame.ready
  )) || null;
  if (!failureMode && !firstCorrectFrame) {
    throw new Error(`${caseName} 未记录到正确配置的可见首帧：${JSON.stringify({firstFrame, finalFrame})}`);
  }
  const domMetrics = await page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector('.popup-shell');
    return {
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      shellWidth: shell?.getBoundingClientRect().width || 0,
      shellHeight: shell?.getBoundingClientRect().height || 0,
      modules: [...document.querySelectorAll('[data-popup-module]')].map(node => node.getAttribute('data-popup-module')),
      quickFeatures: [...document.querySelectorAll('[data-popup-quick-feature]')].map(node => node.getAttribute('data-popup-quick-feature')),
      ready: shell?.getAttribute('data-config-ready'),
      skin: root.dataset.interfaceSkin || shell?.getAttribute('data-interface-skin') || '',
      dark: root.classList.contains('dark'),
    };
  });
  if (domMetrics.horizontalOverflow || domMetrics.shellWidth > 400 || domMetrics.ready !== 'true') {
    throw new Error(`${caseName} Popup 布局指标异常：${JSON.stringify(domMetrics)}`);
  }
  const frameFile = await writeJson(`frames-${fileNamePart(caseName)}.json`, {
    caseName,
    expectFlash,
    configDelayMs: delayMs,
    delayObserved: {
      hookInstalled: startup.delayHookInstalled,
      requestCount: startup.configReadRequests,
      releasedCount: startup.configReadReleased,
      maxDelayMs: startup.configReadDelayMs,
      failureCount: startup.configReadFailures,
    },
    firstCorrectFrame,
    storageReadKeys: startup.storageReadKeys,
    mountCount: startup.mountCount,
    renderMutations: startup.renderMutations,
    firstVisibleShell: firstFrame,
    lastVisibleShell: finalFrame,
    frames: startup.frames,
  });
  const screenshotFile = await screenshot(page, `popup-startup-${fileNamePart(caseName)}.png`);
  report.startupCases.push({
    caseName,
    failureMode,
    firstFrame,
    finalFrame,
    firstCorrectFrame,
    storageReadKeys: startup.storageReadKeys,
    mountCount: startup.mountCount,
    renderMutations: startup.renderMutations,
    flashObserved,
    delayObserved: {
      hookInstalled: startup.delayHookInstalled,
      requestCount: startup.configReadRequests,
      releasedCount: startup.configReadReleased,
      maxDelayMs: startup.configReadDelayMs,
      failureCount: startup.configReadFailures,
    },
    domMetrics,
    frames: frameFile,
    screenshot: screenshotFile,
  });
  await page.close();
}

async function runPersistenceRegression({context, extensionOrigin, popupPath, pageForConfig, report}) {
  const persistence = {
    noOpPagehide: null,
    latestWriteWins: null,
  };
  const openReadyPopup = async (caseName, probeOptions = {}) => {
    const page = await newPageWithoutForeground(context, timeout);
    attachDiagnostics(page, report.consoleErrors);
    await installStartupProbe(page, {delayMs: 0, ...probeOptions});
    await page.setViewportSize({width: 400, height: 600});
    const popupUrl = new URL(popupPath, `${extensionOrigin}/`);
    popupUrl.searchParams.set('startupCase', caseName);
    await page.goto(popupUrl.toString(), {waitUntil: 'domcontentloaded', timeout});
    await page.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
    return page;
  };

  const noOpPage = await openReadyPopup('persistence-no-op-pagehide');
  await noOpPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await noOpPage.waitForTimeout(250);
  const noOpState = await readStartupState(noOpPage);
  persistence.noOpPagehide = {
    persistConfigRequests: noOpState?.persistConfigRequests || 0,
    persistConfigModes: noOpState?.persistConfigModes || [],
    responses: noOpState?.persistConfigResponses || 0,
    successes: noOpState?.persistConfigSuccesses || 0,
    persistConfigBatchRequests: noOpState?.persistConfigBatchRequests || 0,
  };
  if (persistence.noOpPagehide.persistConfigRequests !== 0
    || persistence.noOpPagehide.persistConfigBatchRequests !== 0) {
    throw new Error(`无修改 Popup pagehide 产生了配置保存：${JSON.stringify(persistence.noOpPagehide)}`);
  }
  await noOpPage.close();

  // 冻结首请求给 Popup 的回执，让第二次修改确定停留在页面本地队列。
  // 后台真实处理照常执行；关闭后的成功必须来自补丁链交接，不能依赖机器快慢。
  const modifiedPage = await openReadyPopup('persistence-latest-write-wins', {holdFirstPersistResponse: true});
  const targetSelect = modifiedPage.locator('.language-pair .el-select').nth(1);
  const initialValue = (await readConfig(pageForConfig, timeout)).to;
  const candidates = [
    {value: 'en', label: /English|英语/u},
    {value: 'ja', label: /日本語|Japanese|日语/u},
    {value: 'fr', label: /Français|French|法语/u},
  ].filter(option => option.value !== initialValue);
  const firstTarget = candidates[0].value;
  const finalTarget = candidates[1].value;
  const selectTarget = async candidate => {
    await targetSelect.locator('.el-select__wrapper').click();
    await modifiedPage.locator('.el-select-dropdown:visible').getByRole('option', {name: candidate.label}).click();
  };
  await selectTarget(candidates[0]);
  await modifiedPage.waitForFunction(() => globalThis.__fluentReadPopupStartup?.persistConfigResponseHolds === 1,
    undefined, {timeout});
  await selectTarget(candidates[1]);
  // 直接触发短生命周期关闭，不额外等待保存完成。
  await modifiedPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const modifiedState = await readStartupState(modifiedPage);
  await modifiedPage.close();
  const persistenceDeadline = Date.now() + timeout;
  let savedConfig;
  do {
    savedConfig = await readConfig(pageForConfig, timeout);
    if (savedConfig.to === finalTarget) break;
    await delay(60);
  } while (Date.now() < persistenceDeadline);
  persistence.latestWriteWins = {
    initialValue,
    firstTarget,
    finalTarget,
    persistedValue: savedConfig.to,
    persistConfigRequests: modifiedState?.persistConfigRequests ?? null,
    persistConfigModes: modifiedState?.persistConfigModes || [],
    responses: modifiedState?.persistConfigResponses ?? null,
    successes: modifiedState?.persistConfigSuccesses ?? null,
    heldResponses: modifiedState?.persistConfigResponseHolds ?? null,
    persistConfigBatchRequests: modifiedState?.persistConfigBatchRequests ?? null,
    persistConfigBatchSizes: modifiedState?.persistConfigBatchSizes || [],
  };
  if (modifiedState?.persistConfigResponseHolds !== 1
    || modifiedState?.persistConfigRequests !== 1
    || modifiedState?.persistConfigBatchRequests !== 1
    || modifiedState?.persistConfigBatchSizes?.[0] !== 2) {
    throw new Error(`快速关闭没有交接包含未确认前驱的补丁链：${JSON.stringify(persistence.latestWriteWins)}`);
  }
  if (savedConfig.to !== finalTarget) {
    throw new Error(`连续修改后最终目标语言没有胜出：${JSON.stringify(persistence.latestWriteWins)}`);
  }
  const reopenedPage = await openReadyPopup('persistence-reopened');
  const reopenedLabel = await reopenedPage.locator('.language-pair .el-select').nth(1).innerText();
  persistence.latestWriteWins.reopenedLabel = reopenedLabel;
  if (!candidates[1].label.test(reopenedLabel)) throw new Error(`重新打开后目标语言显示异常：${reopenedLabel}`);
  persistence.latestWriteWins.screenshot = await screenshot(reopenedPage, 'popup-persistence-reopened.png');
  await reopenedPage.close();
  report.persistence.quickClose = persistence;
}

/** 首屏不加载快捷键编辑器，首次懒挂载仍能管理焦点并正确关闭。 */
async function runPopupDeferredUiRegression(context, extensionOrigin, popupPath) {
  const page = await newPageWithoutForeground(context, timeout);
  const requestedScripts = new Set();
  const parsedScripts = new Set();
  const isEditor = url => /CustomHotkeyInput[^/]*\.js$/u.test(url);
  page.on('request', request => { if (isEditor(request.url())) requestedScripts.add(request.url()); });
  const debuggerSession = await context.newCDPSession(page);
  debuggerSession.on('Debugger.scriptParsed', event => { if (isEditor(event.url)) parsedScripts.add(event.url); });
  await debuggerSession.send('Debugger.enable');
  try {
    await page.setViewportSize({width: 400, height: 600});
    await page.goto(new URL(popupPath, `${extensionOrigin}/`).href, {waitUntil: 'domcontentloaded'});
    await page.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
    // chrome-extension 协议不保证写入 Resource Timing；用网络事件与 V8 实际模块解析共同验证。
    if (requestedScripts.size || parsedScripts.size) throw new Error('首屏提前加载了快捷键编辑器');
    await page.locator('[data-popup-quick-feature="hover"]').click();
    await page.locator('.popup-drawer').getByRole('button', {name: '自定义', exact: true}).click();
    const dialog = page.locator('.custom-hotkey-dialog');
    await dialog.waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.activeElement?.closest('.custom-hotkey-dialog'));
    if (parsedScripts.size !== 1) throw new Error(`快捷键编辑器未按需解析：${JSON.stringify([...parsedScripts])}`);
    const dialogScreenshot = await screenshot(page, 'popup-deferred-hotkey-dialog.png');
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await dialog.waitFor({state: 'detached', timeout});
    await page.waitForFunction(() => document.activeElement?.closest('.popup-drawer'));
    return {initialEditorResources: 0, editorLoadedOnDemand: true, requestedScripts: [...requestedScripts],
      parsedScripts: [...parsedScripts], initialFocus: true, restoredFocus: true, dialogScreenshot};
  } finally { await debuggerSession.detach().catch(() => undefined); await page.close(); }
}

/** 在真实 content 上验证取消导航、缓存暂停恢复和原生 Shadow API，而非只测试 helper。 */
async function runContentLifecycleRegression(context, extensionOrigin, popupPath) {
  const server = require('node:http').createServer((request, response) => {
    if (request.url === '/image.svg') {
      response.writeHead(200, {'Content-Type': 'image/svg+xml'});
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="white"/><text x="20" y="100">Image ownership fixture</text></svg>');
      return;
    }
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end('<!doctype html><html><body><h1>Page lifecycle fixture</h1><button id=activate>Activate page</button><p>Keep this page and its extension active.</p><img src="/image.svg" width="400" height="200" alt="Image ownership fixture"></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let page;
  try {
    page = await newPageWithoutForeground(context);
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(fixtureUrl, {waitUntil: 'domcontentloaded'});
    const floating = page.locator('#fluent-read-floating-ball-container');
    await floating.waitFor({state: 'attached', timeout});
    const popup = await newPageWithoutForeground(context, timeout);
    try {
      await popup.goto(new URL(popupPath, `${extensionOrigin}/`).href, {waitUntil: 'domcontentloaded'});
      await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
      await popup.getByRole('switch', {name: '暂停插件', exact: true}).click();
      await floating.waitFor({state: 'detached', timeout});
      await popup.getByRole('switch', {name: '启用插件', exact: true}).click();
      await floating.waitFor({state: 'attached', timeout});
    } finally { await popup.close(); }
    // 宿主脚本合成事件不能控制扩展的生命周期。
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      document.dispatchEvent(new Event('fluentread-route-change'));
    });
    if (await floating.count() !== 1) throw new Error('伪造页面离开事件卸载了扩展');
    await page.locator('#activate').click();
    await page.evaluate(() => {
      window.__leaveGuard = event => { event.preventDefault(); event.returnValue = ''; };
      window.addEventListener('beforeunload', window.__leaveGuard);
    });
    let dismissed = false;
    page.once('dialog', async dialog => { dismissed = dialog.type() === 'beforeunload'; await dialog.dismiss(); });
    await page.goto(`${fixtureUrl}cancelled`).catch(error => {
      if (!String(error).includes('ERR_ABORTED')) throw error;
    });
    if (!dismissed || page.url() !== fixtureUrl || await floating.count() !== 1) {
      throw new Error('取消真实离开确认后页面或扩展状态异常');
    }
    await page.evaluate(() => {
      window.removeEventListener('beforeunload', window.__leaveGuard);
      window.__persistedTransitions = [];
      for (const type of ['pagehide', 'pageshow']) window.addEventListener(type, event => {
        window.__persistedTransitions.push({type, persisted: event.persisted, trusted: event.isTrusted});
      });
    });
    const shadow = await page.evaluate(() => {
      const host = document.createElement('div');
      document.body.append(host);
      let reads = 0;
      const root = host.attachShadow({get mode() {
        if (++reads > 1) throw new Error('mode getter read twice');
        return 'open';
      }});
      let missingArgumentsThrow = false;
      try { history.pushState(); } catch (error) { missingArgumentsThrow = error instanceof TypeError; }
      return {reads, attached: host.shadowRoot === root, missingArgumentsThrow};
    });
    if (shadow.reads !== 1 || !shadow.attached || !shadow.missingArgumentsThrow) throw new Error('Shadow bridge 改变了宿主 API 语义');
    await page.goto(`${fixtureUrl}next`, {waitUntil: 'domcontentloaded'});
    // BFCache 恢复已有文档，不会重新触发 DOMContentLoaded；先等导航提交，再验证 pageshow。
    await page.goBack({waitUntil: 'commit'});
    await floating.waitFor({state: 'attached', timeout});
    if (await floating.count() !== 1) throw new Error('往返恢复重复挂载');
    const transitions = await page.evaluate(() => window.__persistedTransitions || []);
    if (!transitions.some(event => event.type === 'pageshow' && event.persisted && event.trusted)) {
      throw new Error(`本轮未命中真实 BFCache 恢复：${JSON.stringify(transitions)}`);
    }
    await page.locator('img').hover();
    await page.locator('#fluent-read-image-translation-root').waitFor({state: 'attached', timeout});
    await page.evaluate(() => {
      window.__imageRemoveCount = 0;
      const reject = () => {
        const root = document.getElementById('fluent-read-image-translation-root');
        if (root) {window.__imageRemoveCount++; root.remove();}
      };
      window.__imageRejectObserver = new MutationObserver(reject);
      window.__imageRejectObserver.observe(document.documentElement, {childList: true});
      reject();
    });
    await page.waitForFunction(() => window.__imageRemoveCount >= 3);
    await page.waitForTimeout(300);
    const imageRemovals = await page.evaluate(() => window.__imageRemoveCount);
    if (imageRemovals !== 3 || await page.locator('#fluent-read-image-translation-root').count()) {
      throw new Error(`图片浮层持续重挂：${imageRemovals}`);
    }
    await page.evaluate(() => window.__imageRejectObserver.disconnect());
    await page.locator('#activate').hover();
    await page.locator('img').hover();
    await page.locator('#fluent-read-image-translation-root').waitFor({state: 'attached', timeout});
    return {imageOwnership: {removals: imageRemovals, recoveredOnNewHover: true},
      configDrivenGlobalToggle: true, cancelledNavigation: true, forgedEventsIgnored: true, realBackForwardCache: true,
      transitions, shadow, screenshot: await screenshot(page, 'content-lifecycle-restored.png')};
  } finally {
    await page?.close().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const manifestEntrypoints = assertManifest(manifest);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-popup-startup-'));
  const report = {
    ok: false,
    extensionDir,
    extensionEntrypoints: manifestEntrypoints,
    browser: 'Microsoft Edge',
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    expectFlash,
    configDelayMs,
    skin: requestedSkin,
    startupCases: [],
    persistence: {patched: false, restored: false, original: null, target: null},
    consoleErrors: [],
    screenshots: [],
    failure: null,
  };
  let launched;
  let pageForConfig;
  let originalConfig;
  let sequence = 0;
  try {
    launched = await launchFocusSafePersistentContext({
      chromium,
      profileDir,
      browserPath,
      headless: false,
      background: true,
      browserArgs: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: {width: 1440, height: 1000},
      timeout,
    });
    report.launchMode = launched.launchMode;
    report.focusPolicy = launched.focusPolicy;
    report.windowPlacement = launched.windowPlacement;
    const {context} = launched;
    const worker = await extensionWorker(context, timeout);
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    pageForConfig = await newPageWithoutForeground(context, timeout);
    attachDiagnostics(pageForConfig, report.consoleErrors);
    await installStartupProbe(pageForConfig, {delayMs: 0});
    await pageForConfig.setViewportSize({width: 400, height: 600});
    await pageForConfig.goto(`${extensionOrigin}/${manifestEntrypoints.popup}`, {
      waitUntil: 'domcontentloaded',
      timeout,
    });
    await pageForConfig.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
    await pageForConfig.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const freshProfileStartup = await readStartupState(pageForConfig);
    report.firstPopupOnFreshProfile = {
      firstFrame: freshProfileStartup.firstVisibleShell,
      storageReadKeys: freshProfileStartup.storageReadKeys,
      screenshot: await screenshot(pageForConfig, 'popup-first-install.png'),
    };
    originalConfig = await readConfig(pageForConfig, timeout);
    report.persistence.original = summarizeConfig(originalConfig);
    const targetConfig = {
      on: true,
      disableFloatingBall: false,
      disableImageTranslator: false,
      imageTranslationHoverEnabled: true,
      uiLanguageSetupCompleted: true,
      theme: 'dark',
      interfaceSkin: requestedSkin,
      interfaceVisibility: {
        ...(originalConfig.interfaceVisibility || {}),
        popupQuickFeatures: true,
        popupSiteRule: false,
        popupFooter: true,
      },
      popupModuleOrder: MODULE_ORDER,
      popupQuickFeatureOrder: QUICK_FEATURE_ORDER,
      popupQuickFeatureVisibility: {
        ...(originalConfig.popupQuickFeatureVisibility || {}),
        image: false,
      },
    };
    await patchConfig(pageForConfig, targetConfig, ++sequence, timeout);
    report.persistence.patched = true;
    report.persistence.target = summarizeConfig(targetConfig);
    for (const theme of ['dark', 'auto']) {
      const themePatch = {theme};
      await patchConfig(pageForConfig, themePatch, ++sequence, timeout);
      for (let caseIndex = 1; caseIndex <= openCount; caseIndex += 1) {
        await runPopupCase({
          context,
          extensionOrigin,
          popupPath: manifestEntrypoints.popup,
          theme,
          caseIndex,
          report,
        });
      }
    }
    await patchConfig(pageForConfig, {theme: 'auto'}, ++sequence, timeout);
    await runPopupCase({
      context,
      extensionOrigin,
      popupPath: manifestEntrypoints.popup,
      theme: 'auto',
      caseIndex: 'normal-no-delay',
      delayMs: 0,
      enforceFlash: false,
      report,
    });
    await runPopupCase({
      context,
      extensionOrigin,
      popupPath: manifestEntrypoints.popup,
      theme: 'auto',
      caseIndex: 'read-failure',
      failureMode: true,
      report,
    });
    if (!expectFlash) {
      await runPersistenceRegression({
        context,
        extensionOrigin,
        popupPath: manifestEntrypoints.popup,
        pageForConfig,
        report,
      });
    }
    report.deferredUi = await runPopupDeferredUiRegression(context, extensionOrigin, manifestEntrypoints.popup);
    report.contentLifecycle = await runContentLifecycleRegression(context, extensionOrigin, manifestEntrypoints.popup);
    report.screenshots = report.startupCases.map(item => item.screenshot);
    // 读回并恢复测试前的公开 UI 配置，避免留下测试状态；凭据始终不参与日志或 patch。
    const restorePatch = {
      on: originalConfig.on,
      disableFloatingBall: originalConfig.disableFloatingBall,
      disableImageTranslator: originalConfig.disableImageTranslator,
      imageTranslationHoverEnabled: originalConfig.imageTranslationHoverEnabled,
      uiLanguageSetupCompleted: originalConfig.uiLanguageSetupCompleted,
      theme: originalConfig.theme,
      interfaceSkin: originalConfig.interfaceSkin,
      interfaceVisibility: originalConfig.interfaceVisibility,
      popupModuleOrder: originalConfig.popupModuleOrder,
      popupQuickFeatureOrder: originalConfig.popupQuickFeatureOrder,
      popupQuickFeatureVisibility: originalConfig.popupQuickFeatureVisibility,
    };
    await patchConfig(pageForConfig, restorePatch, ++sequence, timeout);
    report.persistence.restored = true;
    report.ok = true;
  } catch (error) {
    report.failure = serializableError(error);
    throw error;
  } finally {
    report.consoleErrors = report.consoleErrors.slice(0, 100);
    await writeJson('report.json', report);
    await pageForConfig?.close().catch(() => undefined);
    await launched?.close().catch(() => undefined);
    fs.rmSync(profileDir, {recursive: true, force: true});
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
