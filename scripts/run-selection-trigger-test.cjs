#!/usr/bin/env node

// 使用临时 Edge profile 验证划词翻译的触发矩阵；--context-menu-only 只运行右键入口专项，
// --lifecycle-only 检查宿主节点恢复、启停、路由、失败重试与键盘/窄屏界面，要求 --runtime-diagnostics。
// --document-shell-only 只验证 DeepSeek 类文档根禁译外壳下的划词入口与局部保护。
// --click-selection-only 只验证按需两点选取；通过 --runtime-diagnostics 传入 CDP 诊断收集器。
// --click-selection-stress-only 只诊断滚动后立即确认终点的重复手势与事件时序。
// Popup 快捷抽屉提供独立启用开关与双语/仅译文选择；触发方式、显示延迟和自定义快捷键在完整设置页修改，
// 两个真实扩展页面同时打开，断言设置页写入、Popup 模式同步与网页中的真实划词手势结果一致。
// 该脚本只操作本次创建的隔离 profile，不连接用户正在使用的浏览器。

const {guardBrowserClose, getGuardedBrowserPid} = require('./testing/owned-browser-close.cjs');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const TARGET_TEXT = 'When switching between different filaments, the printer flushes residual material before printing.';
const CONFIG_FIXTURE_CLIENT_ID = `selection-trigger-${process.pid}-${Date.now()}`;
let configFixtureSequence = 0;
let activateInputPage = async () => undefined;
let assertBackgroundFocus = async () => undefined;
let createIsolatedPage = context => context.newPage();
const selectionUiSessions = new WeakMap();
const selectionUiTrackers = new WeakMap();
const ownedSelectionUiTrackers = new Set();

function readArg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function parseArgs(argv) {
  const args = {
    extensionDir: readArg(argv, 'extension-dir', '.output/chrome-mv3'),
    playwrightRoot: readArg(argv, 'playwright-root', process.env.PLAYWRIGHT_ROOT),
    artifactsDir: readArg(argv, 'artifacts-dir', path.join(os.tmpdir(), 'fluentread-selection-trigger-test')),
    browserPath: readArg(argv, 'browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    focusSafeHelper: readArg(argv, 'focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs')),
    headed: argv.includes('--headed'),
    chineseOnly: argv.includes('--chinese-only'),
    contextMenuOnly: argv.includes('--context-menu-only'),
    lifecycleOnly: argv.includes('--lifecycle-only'),
    documentShellOnly: argv.includes('--document-shell-only'),
    directionOnly: argv.includes('--direction-only'),
    geometryOnly: argv.includes('--geometry-only'),
    zoomOnly: argv.includes('--zoom-only'),
    scrollOnly: argv.includes('--scroll-only'),
    inlineCodeOnly: argv.includes('--inline-code-only'),
    clickSelectionOnly: argv.includes('--click-selection-only') || argv.includes('--click-selection-stress-only'),
    clickSelectionStressOnly: argv.includes('--click-selection-stress-only'),
    runtimeDiagnostics: readArg(argv, 'runtime-diagnostics', ''),
  };
  if ((args.clickSelectionOnly || args.documentShellOnly || args.lifecycleOnly) && (!args.runtimeDiagnostics || !fs.existsSync(args.runtimeDiagnostics))) {
    throw new Error('划词专项需要 --runtime-diagnostics <runtime-diagnostics.cjs> 以采集扩展隔离世界及后台诊断');
  }
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root，或设置 PLAYWRIGHT_ROOT');
  args.extensionDir = path.resolve(args.extensionDir);
  args.artifactsDir = path.resolve(args.artifactsDir);
  if (args.focusSafeHelper) args.focusSafeHelper = path.resolve(args.focusSafeHelper);
  if (!args.headed && !args.focusSafeHelper) {
    throw new Error('后台模式必须传入 --focus-safe-helper，确保真实浏览器不抢占前台焦点');
  }
  if (!fs.existsSync(path.join(args.extensionDir, 'manifest.json'))) {
    throw new Error(`找不到扩展构建产物：${args.extensionDir}`);
  }
  if (!fs.existsSync(args.browserPath)) throw new Error(`浏览器不存在：${args.browserPath}`);
  if (args.focusSafeHelper && !fs.existsSync(args.focusSafeHelper)) {
    throw new Error(`找不到后台浏览器辅助脚本：${args.focusSafeHelper}`);
  }
  return args;
}

function loadPlaywright(root) {
  try {
    return require('playwright');
  } catch {
    const runtimeRequire = createRequire(path.join(path.resolve(root), '__fluentread_selection_trigger_test__.cjs'));
    return runtimeRequire('playwright');
  }
}

function loadFocusSafeBrowser(helperPath) {
  const helper = require(helperPath);
  for (const name of ['launchFocusSafePersistentContext', 'newPageWithoutForeground', 'activateExtensionTabWithoutForeground']) {
    if (typeof helper[name] !== 'function') throw new Error(`后台浏览器辅助脚本缺少接口：${name}`);
  }
  return helper;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDedicatedProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const home = os.homedir();
  const forbiddenRoots = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
  ];
  for (const root of forbiddenRoots) {
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
    }
  }
}

async function waitForWorker(context) {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
  assert(extensionId, `无法获取扩展 ID：${worker.url()}`);
    return { worker, extensionId };
}

async function sendExtensionMessage(extensionPage, message) {
  return extensionPage.evaluate((request) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`后台消息超时：${request.type}`)), 10000);
    chrome.runtime.sendMessage(request, (response) => {
      const lastError = chrome.runtime.lastError?.message;
      clearTimeout(timer);
      if (lastError) reject(new Error(lastError));
      else resolve(response);
    });
  }), message);
}

function parseConfigRecord(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function readConfigRecord(extensionPage, key) {
  const response = await sendExtensionMessage(extensionPage, { type: 'configStorageRead', key });
  if (response?.success !== true) {
    throw new Error(`后台配置读取失败（${key}）：${response?.error || '没有返回结果'}`);
  }
  return parseConfigRecord(response.value);
}

async function readStoredConfig(extensionPage) {
  const [publicConfig, localCredentials, sessionCredentials] = await Promise.all([
    readConfigRecord(extensionPage, 'local:config'),
    readConfigRecord(extensionPage, 'local:credentials'),
    readConfigRecord(extensionPage, 'session:credentials'),
  ]);
  const credentials = Object.keys(localCredentials).length ? localCredentials : sessionCredentials;
  const credentialFields = { ...credentials };
  delete credentialFields.schemaVersion;
  return { ...publicConfig, ...credentialFields };
}

function configPatchMatches(config, patch) {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(config[key]) === JSON.stringify(value));
}

async function patchStoredConfig(extensionPage, patch) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await readStoredConfig(extensionPage);
    const baseRevision = current.__fluentConfigRevision;
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new Error(`后台配置缺少有效 revision：${JSON.stringify(baseRevision)}`);
    }
    const response = await sendExtensionMessage(extensionPage, {
      type: 'persistConfig',
      config: { ...current, ...patch },
      clientId: CONFIG_FIXTURE_CLIENT_ID,
      sequence: ++configFixtureSequence,
      baseRevision,
    });
    if (response?.success !== true) {
      if (String(response?.error || '').includes('配置已更新') && attempt < 3) continue;
      throw new Error(`后台配置保存失败：${response?.error || '没有返回结果'}`);
    }
    if (!Number.isSafeInteger(response.revision) || response.revision < 0) {
      throw new Error(`后台配置保存没有返回有效 revision：${JSON.stringify(response)}`);
    }

    const deadline = Date.now() + 10000;
    let verified = {};
    while (Date.now() < deadline) {
      verified = await readStoredConfig(extensionPage);
      if (verified.__fluentConfigRevision >= response.revision && configPatchMatches(verified, patch)) {
        return verified;
      }
      await extensionPage.waitForTimeout(50);
    }
    throw new Error(`后台配置没有完成持久化：${JSON.stringify({ patch, response, verified })}`);
  }
  throw new Error(`后台配置 revision 连续冲突：${JSON.stringify(patch)}`);
}

async function assertBackgroundRoundTrip(extensionPage) {
  const response = await extensionPage.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后台消息 round-trip 超时')), 10000);
    chrome.runtime.sendMessage({type: 'FLUENT_READ_BROWSER_FIXTURE_PING'}, (message) => {
      const lastError = chrome.runtime.lastError?.message;
      clearTimeout(timer);
      if (lastError) reject(new Error(lastError));
      else resolve(message);
    });
  }));
  assert(response?.success === false && response?.error === '不支持的后台消息',
    `后台消息 round-trip 返回异常：${JSON.stringify(response)}`);
}

async function waitForContentScript(page) {
  await page.locator('#fluent-read-page-styles').waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForTimeout(700);
}

const SELECTION_MODE_VALUES = { 双语显示: 'bilingual', 仅译文: 'translation-only' };

async function openSelectionDrawer(popup) {
  await activateInputPage(popup);
  await popup.locator('[data-popup-quick-feature="selection"]').click();
  const drawer = popup.locator('.popup-drawer:visible').last();
  await drawer.getByRole('group', { name: '划词翻译模式' }).waitFor({ state: 'visible', timeout: 60000 });
  return drawer;
}

async function openSelectionOptions(context, extensionId, result) {
  const options = await createIsolatedPage(context);
  options.on('pageerror', (error) => result.consoleErrors.push(`options pageerror: ${error.message}`));
  options.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(`options console: ${message.text()}`); });
  await options.goto(`chrome-extension://${extensionId}/options.html#settings-selection`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await options.getByRole('switch', { name: '启用划词翻译' }).waitFor({ state: 'visible', timeout: 60000 });
  return options;
}

async function setSelectionMode(ui, label) {
  const expected = SELECTION_MODE_VALUES[label];
  assert(expected, `未知划词模式：${label}`);
  const button = ui.drawer.getByRole('group', { name: '划词翻译模式' }).getByRole('button', { name: label, exact: true });
  await activateInputPage(ui.popup);
  await button.click();
  const deadline = Date.now() + 10000;
  let state = null;
  while (Date.now() < deadline) {
    const config = await readStoredConfig(ui.storagePage);
    state = {
      pressed: await button.getAttribute('aria-pressed'),
      mode: config.selectionTranslatorMode,
      disabled: config.disableSelectionTranslator,
    };
    if (state.pressed === 'true' && state.mode === expected && state.disabled === (expected === 'disabled')) return state;
    await ui.popup.waitForTimeout(100);
  }
  throw new Error(`划词模式没有保存为 ${label}：${JSON.stringify(state)}`);
}

async function setSelectionEnabled(ui, enabled) {
  // 真正的开关保留关闭前的显示偏好；禁用时模式按钮不能充当启用入口。
  await activateInputPage(ui.popup);
  const toggle = ui.drawer.getByRole('switch', { name: '划词翻译', exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click();
  const deadline = Date.now() + 10000;
  let state = null;
  while (Date.now() < deadline) {
    const config = await readStoredConfig(ui.storagePage);
    state = { popup: await readPopupSelectionState(ui.drawer), mode: config.selectionTranslatorMode, disabled: config.disableSelectionTranslator };
    if (state.popup.checked === String(enabled) && state.popup.modes.length === 2 && (state.mode !== 'disabled') === enabled
      && state.disabled === !enabled && state.popup.modes.every(mode => mode.disabled === !enabled)) return state;
    await ui.popup.waitForTimeout(100);
  }
  throw new Error(`划词翻译启用状态错误：${JSON.stringify({ enabled, state })}`);
}

function expectedSelectionTrigger(label) {
  return label === '直接弹出'
    ? { trigger: 'direct', hotkey: 'none' }
    : label === '仅右键菜单'
      ? { trigger: 'contextMenu', hotkey: 'none' }
    : label === '显示图标'
      ? { trigger: 'icon', hotkey: 'none' }
      : label === '显示小点'
        ? { trigger: 'dot', hotkey: 'none' }
        : label === 'Ctrl'
          ? { trigger: 'Control', hotkey: 'Control' }
          : label === 'Alt / Option'
            ? { trigger: 'Alt', hotkey: 'Alt' }
            : label === 'Shift'
              ? { trigger: 'Shift', hotkey: 'Shift' }
              : { trigger: 'custom', hotkey: 'custom' };
}

function selectionTriggerSelect(options) {
  const input = options.locator('input[aria-label="划词翻译触发方式"]');
  const wrapper = input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]');
  return { input, wrapper };
}

async function readPopupSelectionState(drawer) {
  return drawer.evaluate(element => {
    const toggle = element.querySelector('[data-testid="selection-enable"]');
    const group = element.querySelector('[role="group"][aria-label="划词翻译模式"]');
    return { checked: toggle?.getAttribute('aria-checked'), modes: [...(group?.querySelectorAll('button') || [])]
      .map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute('aria-pressed'), disabled: button.disabled })) };
  });
}

async function waitForSelectionTriggerState(ui, label, timeout = 10000) {
  const expected = expectedSelectionTrigger(label);
  const { wrapper } = selectionTriggerSelect(ui.options);
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    const config = await readStoredConfig(ui.storagePage);
    lastState = {
      options: (await wrapper.locator('.el-select__placeholder').first().textContent())?.trim() || '',
      popup: await readPopupSelectionState(ui.drawer),
      trigger: config.selectionTranslatorTrigger,
      hotkey: config.selectionTranslatorHotkey,
      customHotkey: config.customSelectionTranslatorHotkey || '',
    };
    if (lastState.options === label
      && lastState.popup.checked === String(config.selectionTranslatorMode !== 'disabled')
      && lastState.popup.modes.length === 2
      && lastState.popup.modes.every(mode => mode.pressed === String(SELECTION_MODE_VALUES[mode.label] ===
        (config.selectionTranslatorMode === 'disabled' ? config.selectionTranslatorModeBeforeDisable : config.selectionTranslatorMode))
        && mode.disabled === (config.selectionTranslatorMode === 'disabled'))
      && config.selectionTranslatorTrigger === expected.trigger
      && config.selectionTranslatorHotkey === expected.hotkey
      && (label !== '自定义' || config.customSelectionTranslatorHotkey === 'F9')) {
      return { label, ...lastState };
    }
    await ui.options.waitForTimeout(100);
  }
  throw new Error(`选择 ${label} 后设置页、Popup 模式或配置未稳定：${JSON.stringify(lastState)}`);
}

async function setSelectionTrigger(ui, label) {
  await activateInputPage(ui.options);
  const { input, wrapper } = selectionTriggerSelect(ui.options);
  await input.waitFor({ state: 'visible', timeout: 15000 });
  const current = (await wrapper.locator('.el-select__placeholder').first().textContent())?.trim();
  if (current !== label) {
    await wrapper.click();
    const dropdown = ui.options.locator('.el-select-dropdown:visible').last();
    await dropdown.waitFor({ state: 'visible', timeout: 10000 });
    await dropdown.getByRole('option', { name: label, exact: true }).click();
    await dropdown.waitFor({ state: 'hidden', timeout: 10000 });
  }

  if (label === '自定义') {
    // 首次选择会自动打开录制框；已有 F9 时保持原组合，其他组合通过编辑按钮改回 F9。
    let dialog = ui.options.locator('.custom-hotkey-dialog:visible').last();
    try {
      await dialog.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      if ((await readStoredConfig(ui.storagePage)).customSelectionTranslatorHotkey !== 'F9') {
        await ui.options.getByRole('button', { name: '编辑划词翻译快捷键', exact: true }).click();
        dialog = ui.options.locator('.custom-hotkey-dialog:visible').last();
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
      }
    }
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'F9', exact: true }).click();
      await dialog.getByRole('button', { name: '确认', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    }
  }

  return waitForSelectionTriggerState(ui, label);
}

async function setSelectionDelay(ui, delay, settleMs = 500) {
  await activateInputPage(ui.options);
  const input = ui.options.locator('input[aria-label="划词翻译显示延迟"]');
  await input.fill(String(delay));
  await input.press('Tab');
  await ui.options.waitForTimeout(settleMs);
  const deadline = Date.now() + 5000;
  let config = await readStoredConfig(ui.storagePage);
  while (config.selectionTranslatorDelay !== delay && Date.now() < deadline) {
    await ui.options.waitForTimeout(50);
    config = await readStoredConfig(ui.storagePage);
  }
  assert(config.selectionTranslatorDelay === delay,
    `划词显示延迟没有保存：期望 ${delay}，实际 ${config.selectionTranslatorDelay}`);
  return config.selectionTranslatorDelay;
}

async function resetFixture(page) {
  await page.evaluate((targetText) => {
    document.querySelector('#selection-test-fixture')?.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <main id="selection-test-fixture" style="padding: 80px; font: 24px/1.7 Arial, sans-serif;">
        <p id="target" style="max-width: 900px;">${targetText}</p>
        <p id="neighbor">This neighboring paragraph must remain untouched.</p>
      </main>`);
  }, TARGET_TEXT);
  await page.waitForTimeout(200);
}

async function resetTripleClickFixture(page, buttonVisible = false) {
  await page.evaluate(({ targetText, visible }) => {
    document.querySelector('#selection-test-fixture')?.remove();
    const buttonDisplay = visible ? 'inline-block' : 'none';
    document.body.insertAdjacentHTML('beforeend', `
      <main id="selection-test-fixture" style="padding: 80px; font: 24px/1.7 Arial, sans-serif;">
        <article id="selection-triple-click-review" style="max-width: 900px;">
          <p id="target" style="margin: 0;">${targetText}</p>
          <button id="selection-triple-click-more" type="button" style="display: ${buttonDisplay};">more</button>
          <div id="selection-triple-click-footer"><span>1 reply</span></div>
        </article>
        <p id="neighbor">This neighboring paragraph must remain untouched.</p>
      </main>`);
  }, { targetText: TARGET_TEXT, visible: buttonVisible });
  await page.waitForTimeout(200);
}

async function selectTarget(page, dispatchPointerUpAfterFallback = false) {
  await activateInputPage(page);
  const target = page.locator('#target');
  const box = await target.boundingBox();
  assert(box, '目标段落没有可用几何位置');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(box.x + box.width - 8, box.x + 520), y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  let selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
  let method = 'mouse';
  // 屏幕外窗口在部分 macOS 图形会话中不会把鼠标拖拽交给网页；
  // 使用同一个真实 DOM Range 事件继续验证扩展的选区处理，不跳过后续触发矩阵。
  if (!selectedText) {
    method = 'dom-range-fallback';
    // 先用 CDP 产生可信 pointer 交互，再通过 Selection API 构造精确 Range。
    // 浏览器会自行发送可信 selectionchange；不要补发可被网页伪造的事件。
    await page.mouse.click(box.x + 8, y);
    await page.evaluate(() => {
      const target = document.querySelector('#target');
      const textNode = target?.firstChild;
      if (!textNode) return;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(textNode.textContent?.length || 0, 72));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.waitForTimeout(500);
    selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
    if (dispatchPointerUpAfterFallback) {
      // 已由上面的真实 CDP click 建立可信交互；这里只给浏览器事件队列留出时间。
      await page.waitForTimeout(50);
    }
  }
  assert(selectedText.length > 0, '划词测试没有产生选区');
  return { text: selectedText, method };
}

async function tripleClickTarget(page) {
  await activateInputPage(page);
  await page.keyboard.press('Escape');
  const target = page.locator('#target');
  const box = await target.boundingBox();
  assert(box, '三击测试的目标段落没有可用几何位置');
  await page.evaluate(() => {
    const targetElement = document.querySelector('#target');
    if (!targetElement) throw new Error('三击测试找不到目标段落');
    globalThis.__fluentReadTripleClickMouseDownSequence = [];
    targetElement.addEventListener('mousedown', (event) => {
      globalThis.__fluentReadTripleClickMouseDownSequence.push({
        isTrusted: event.isTrusted,
        detail: event.detail,
        button: event.button,
      });
    }, { capture: true });
  });
  await page.mouse.click(
    box.x + Math.min(80, Math.max(8, box.width / 2)),
    box.y + box.height / 2,
    { button: 'left', clickCount: 3, delay: 80 },
  );
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) throw new Error('原生三击没有产生选区 Range');
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    const sourceButton = document.querySelector('#selection-triple-click-more');
    const fragmentButton = fragment.querySelector('#selection-triple-click-more');
    const rangeRects = Array.from(range.getClientRects(), rect => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }));
    const buttonRects = sourceButton
      ? Array.from(sourceButton.getClientRects(), rect => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        }))
      : [];
    const rectsOverlap = (first, second) => first.right > second.left
      && first.left < second.right
      && first.bottom > second.top
      && first.top < second.bottom;
    const describeBoundary = (node, offset) => ({
      nodeName: node.nodeName,
      tagName: node.nodeType === Node.ELEMENT_NODE ? node.tagName : node.parentElement?.tagName || '',
      id: node.nodeType === Node.ELEMENT_NODE ? node.id : node.parentElement?.id || '',
      offset,
    });
    let intersectsButton = false;
    if (sourceButton) {
      try { intersectsButton = range.intersectsNode(sourceButton); } catch { /* 断开节点不应阻塞诊断。 */ }
    }
    const buttonStyle = sourceButton ? getComputedStyle(sourceButton) : null;
    const selectedText = selection.toString();
    const mouseDownSequence = globalThis.__fluentReadTripleClickMouseDownSequence || [];
    return {
      mouseDown: mouseDownSequence.at(-1) || null,
      mouseDownSequence,
      text: selectedText.trim(),
      rawText: selectedText,
      rangeCount: selection.rangeCount,
      isCollapsed: selection.isCollapsed,
      start: describeBoundary(range.startContainer, range.startOffset),
      end: describeBoundary(range.endContainer, range.endOffset),
      rangeRects,
      fragment: {
        text: fragment.textContent || '',
        button: fragmentButton ? {
          tagName: fragmentButton.tagName,
          text: fragmentButton.textContent || '',
        } : null,
        footer: Boolean(fragment.querySelector('#selection-triple-click-footer')),
      },
      sourceButton: sourceButton ? {
        text: sourceButton.textContent || '',
        display: buttonStyle?.display || '',
        visibility: buttonStyle?.visibility || '',
        opacity: buttonStyle?.opacity || '',
        rects: buttonRects,
        intersectsRange: intersectsButton,
        overlapsSelectionRects: buttonRects.some(buttonRect => rangeRects.some(rangeRect => rectsOverlap(buttonRect, rangeRect))),
      } : null,
      selectedTextIncludesButtonText: Boolean(sourceButton?.textContent && selectedText.includes(sourceButton.textContent)),
    };
  });
}

async function selectTextWithDomRange(page, selector, maxLength = 72) {
  await activateInputPage(page);
  await page.keyboard.press('Escape');
  return page.evaluate(({ selector: targetSelector, maxLength: targetLength }) => new Promise((resolve, reject) => {
    const target = document.querySelector(targetSelector);
    const textNode = target?.firstChild;
    if (!textNode) { reject(new Error(`找不到选区节点：${targetSelector}`)); return; }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(textNode.textContent?.length || 0, targetLength));
    const selection = window.getSelection();
    const timeout = window.setTimeout(() => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      reject(new Error(`浏览器没有产生可信 selectionchange：${targetSelector}`));
    }, 2000);
    const handleSelectionChange = (event) => {
      if (!event.isTrusted) return;
      const text = selection?.toString().trim() || '';
      if (!text) return;
      window.clearTimeout(timeout);
      document.removeEventListener('selectionchange', handleSelectionChange);
      const selectedAt = performance.now();
      resolve({ text, selectedAt, selectedWallAt: performance.timeOrigin + selectedAt });
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }), { selector, maxLength });
}

async function clearSelectionAfter(page, selector, delayMs) {
  return page.evaluate(async ({ selector: targetSelector, delay }) => {
    const target = document.querySelector(targetSelector);
    const textNode = target?.firstChild;
    if (!textNode) throw new Error(`找不到选区节点：${targetSelector}`);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await new Promise(resolve => setTimeout(resolve, delay));
    selection?.removeAllRanges();
  }, { selector, delay: delayMs });
}

async function replaceSelectionAfter(page, firstSelector, secondSelector, delayMs, maxLength = 72) {
  return page.evaluate(async ({ first, second, delay, length }) => {
    const select = (selector) => {
      const target = document.querySelector(selector);
      const textNode = target?.firstChild;
      if (!textNode) throw new Error(`找不到选区节点：${selector}`);
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(textNode.textContent?.length || 0, length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString().trim() || '';
    };
    select(first);
    await new Promise(resolve => setTimeout(resolve, delay));
    const text = select(second);
    const selectedAt = performance.now();
    return { text, selectedAt, selectedWallAt: performance.timeOrigin + selectedAt };
  }, { first: firstSelector, second: secondSelector, delay: delayMs, length: maxLength });
}

function cdpAttribute(node, name) {
  const attributes = node?.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1] || '';
  }
  return '';
}

function cdpHasAttribute(node, name) {
  const attributes = node?.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return true;
  }
  return false;
}

function cdpChildren(node) {
  return [
    ...(node?.children || []),
    ...(node?.shadowRoots || []),
    ...(node?.contentDocument ? [node.contentDocument] : []),
  ];
}

function findCdpNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of cdpChildren(node)) {
    const match = findCdpNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function hasCdpClass(node, className) {
  return cdpAttribute(node, 'class').split(/\s+/).includes(className);
}

function cdpText(node) {
  if (!node) return '';
  if (node.nodeName === '#text') return node.nodeValue || '';
  return cdpChildren(node).map(cdpText).join('');
}

function findCdpDescendantByName(node, name) {
  return findCdpNode(node, candidate => candidate !== node && candidate.nodeName === name);
}

async function getSelectionUiTree(page) {
  let session = selectionUiSessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    await session.send('DOM.enable', { includeWhitespace: 'all' });
    selectionUiSessions.set(page, session);
  }
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  return { session, root };
}

async function readSelectionUi(page) {
  const [{ root }, pageState] = await Promise.all([
    getSelectionUiTree(page),
    page.evaluate(() => ({
      selectionText: window.getSelection()?.toString().trim() || '',
      targetText: document.querySelector('#target')?.textContent || '',
    })),
  ]);
  const host = findCdpNode(root, node => cdpAttribute(node, 'id') === 'fluent-read-selection-translator-container');
  const translatorRoot = findCdpNode(host, node => hasCdpClass(node, 'fr-selection-translator-root'));
  const indicator = findCdpNode(host, node => hasCdpClass(node, 'fr-selection-indicator'));
  const tooltip = findCdpNode(host, node => hasCdpClass(node, 'fr-translation-tooltip'));
  const brandIcon = findCdpNode(tooltip, node => hasCdpClass(node, 'fr-tooltip-brand-icon'));
  const original = findCdpNode(host, node => hasCdpClass(node, 'fr-original-text'));
  const translation = findCdpNode(host, node => hasCdpClass(node, 'fr-translation-result'));
  const loading = findCdpNode(host, node => hasCdpClass(node, 'fr-loading-state'));
  const error = findCdpNode(host, node => hasCdpClass(node, 'fr-error-state'));
  const sourceCopyButton = findCdpNode(host, node => cdpAttribute(node, 'data-copy-kind') === 'source');
  const translationCopyButton = findCdpNode(host, node => cdpAttribute(node, 'data-copy-kind') === 'translation');
  const originalPre = findCdpDescendantByName(original, 'PRE');
  const translationPre = findCdpDescendantByName(translation, 'PRE');
  const navigation = findCdpNode(tooltip, node => hasCdpClass(node, 'fr-study-navigation'));
  const standaloneHeader = findCdpNode(tooltip, node => hasCdpClass(node, 'fr-tooltip-header'));
  const targetLanguageControl = findCdpNode(tooltip, node => cdpHasAttribute(node, 'data-target-language'));
  return {
    host: Boolean(host),
    configuredDelay: Number(cdpAttribute(translatorRoot, 'data-display-delay') || -1),
    indicator: Boolean(indicator),
    readingIndicator: Boolean(findCdpNode(host, node => hasCdpClass(node, 'fr-reading-indicator'))),
    indicatorClass: cdpAttribute(indicator, 'class'),
    tooltip: Boolean(tooltip),
    brandIcon: {
      present: Boolean(brandIcon),
      src: cdpAttribute(brandIcon, 'src'),
    },
    original: Boolean(original),
    translation: Boolean(translation),
    loading: Boolean(loading),
    loadingText: cdpText(loading).trim(),
    error: Boolean(error),
    errorText: cdpText(error).trim(),
    retryButton: Boolean(findCdpNode(error, node => node.nodeName === 'BUTTON')),
    originalText: cdpText(originalPre).trim(),
    resultText: cdpText(translationPre).trim(),
    navigation: {
      present: Boolean(navigation),
      standaloneHeader: Boolean(standaloneHeader),
      targetLanguageControl: Boolean(targetLanguageControl),
      close: Boolean(findCdpNode(navigation, node => hasCdpClass(node, 'fr-close-btn'))),
      share: Boolean(findCdpNode(navigation, node => hasCdpClass(node, 'fr-share-card-entry'))),
      vocabulary: Boolean(findCdpNode(navigation, node => hasCdpClass(node, 'fr-vocabulary-btn'))),
    },
    tooltipText: cdpText(tooltip).trim(),
    copyButtons: {
      source: Boolean(sourceCopyButton),
      translation: Boolean(translationCopyButton),
      sourceLabel: cdpText(sourceCopyButton).trim(),
      translationLabel: cdpText(translationCopyButton).trim(),
    },
    ...pageState,
  };
}

async function sampleSelectionUiTracker(page, tracker) {
  const state = await readSelectionUi(page);
  if (!tracker.active) return;
  const next = { at: Date.now(), tooltip: state.tooltip, indicator: state.indicator };
  const previous = tracker.transitions.at(-1);
  if (!previous || previous.tooltip !== next.tooltip || previous.indicator !== next.indicator) {
    tracker.transitions.push(next);
  }
}

async function startSelectionUiTracking(page) {
  const previous = selectionUiTrackers.get(page);
  if (previous) {previous.active = false; clearInterval(previous.timer); ownedSelectionUiTrackers.delete(previous);}
  const tracker = { transitions: [], timer: null, busy: false, active: true };
  await sampleSelectionUiTracker(page, tracker);
  tracker.timer = setInterval(async () => {
    if (tracker.busy || !tracker.active) return;
    tracker.busy = true;
    try { await sampleSelectionUiTracker(page, tracker); } catch { /* 页面正在切换时忽略该次采样。 */ }
    finally {tracker.busy = false;}
  }, 25);
  selectionUiTrackers.set(page, tracker);
  ownedSelectionUiTrackers.add(tracker);
}

async function stopSelectionUiTracking(page) {
  const tracker = selectionUiTrackers.get(page);
  if (!tracker) return [];
  clearInterval(tracker.timer);
  while (tracker.busy) await page.waitForTimeout(5);
  await sampleSelectionUiTracker(page, tracker).catch(() => {});
  tracker.active = false;
  ownedSelectionUiTrackers.delete(tracker);
  selectionUiTrackers.delete(page);
  return tracker.transitions;
}

async function exerciseTransientSelectionLoss(page, restoreDelayMs = 80) {
  await startSelectionUiTracking(page);
  let transitions;
  try {
  await page.evaluate(async (delayMs) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) throw new Error('瞬时选区测试缺少活动选区');
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    selection.removeAllRanges();
    await new Promise(resolve => setTimeout(resolve, delayMs));
    for (const range of ranges) selection.addRange(range);
  }, restoreDelayMs);
  await page.waitForTimeout(350);
  } finally {transitions = await stopSelectionUiTracking(page);}
  assert(transitions.length > 0 && transitions.every(item => item.tooltip), `瞬时选区变化导致翻译框闪退：${JSON.stringify(transitions)}`);
  return transitions;
}

async function clearPageSelection(page) {
  await activateInputPage(page);
  await page.mouse.click(20, 20);
  if (await page.evaluate(() => Boolean(window.getSelection()?.toString()))) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }
}

async function waitForHoverTranslation(page) {
  await page.waitForFunction(() => document.querySelectorAll('#target .fluent-read-bilingual-content').length === 1, undefined, { timeout: 10000 });
  const pageState = await page.evaluate(() => ({
    count: document.querySelectorAll('#target .fluent-read-bilingual-content').length,
    text: document.querySelector('#target .fluent-read-bilingual-content')?.textContent?.trim() || '',
  }));
  const selectionState = await readSelectionUi(page);
  return { ...pageState, selectionTooltip: selectionState.tooltip };
}

async function waitForSelectionUi(page, expected, description) {
  const deadline = Date.now() + 10000;
  let state;
  while (Date.now() < deadline) {
    state = await readSelectionUi(page);
    const matches = Object.entries(expected).every(([key, value]) => key === 'resultPrefix'
      ? state.resultText.startsWith(String(value))
      : key === 'resultSuffix' ? state.resultText.endsWith(String(value)) : state[key] === value);
    if (matches) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${description}：等待划词 UI 超时，最后状态 ${JSON.stringify(state)}`);
}

async function clickSelectionIndicator(page) {
  await activateInputPage(page);
  const { session, root } = await getSelectionUiTree(page);
  const indicator = findCdpNode(root, node => hasCdpClass(node, 'fr-selection-indicator'));
  if (!indicator) throw new Error('找不到划词翻译入口');
  const { model } = await session.send('DOM.getBoxModel', { nodeId: indicator.nodeId });
  const quad = model.border || model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function clickSelectionCopyButton(page, kind) {
  await activateInputPage(page);
  const { session, root } = await getSelectionUiTree(page);
  const button = findCdpNode(root, node => cdpAttribute(node, 'data-copy-kind') === kind);
  if (!button) throw new Error(`找不到${kind === 'source' ? '原文' : '译文'}复制按钮`);
  const { model } = await session.send('DOM.getBoxModel', { nodeId: button.nodeId });
  const quad = model.border || model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function waitForCopyFeedback(page, expectedText) {
  const deadline = Date.now() + 3000;
  let actualText = '';
  while (Date.now() < deadline) {
    const { root } = await getSelectionUiTree(page);
    const toast = findCdpNode(root, node => hasCdpClass(node, 'fr-copy-success-toast'));
    actualText = cdpText(toast).trim();
    if (actualText === expectedText) return actualText;
    await page.waitForTimeout(50);
  }
  throw new Error(`复制反馈不符合预期：期望 ${expectedText}，实际 ${actualText}`);
}

async function closeSelectionUi(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// 仅观察可信网页右键事件；菜单项点击通过生产消息重放，不操作系统原生菜单。
async function captureRightClickAndDropSelection(page, selector = '#target', expectedText) {
  await activateInputPage(page);
  const box = await page.locator(selector).boundingBox();
  assert(box, `右键目标没有可用几何位置：${selector}`);
  await page.evaluate(() => {
    globalThis.__fluentReadContextMenuGesture = null;
    document.addEventListener('contextmenu', event => {
      const selection = window.getSelection();
      globalThis.__fluentReadContextMenuNativeRange = selection?.rangeCount
        ? selection.getRangeAt(0).cloneRange() : null;
      globalThis.__fluentReadContextMenuGesture = {
        isTrusted: event.isTrusted,
        button: event.button,
        selectedText: window.getSelection()?.toString().trim() || '',
        target: event.target instanceof Element ? event.target.tagName : '',
      };
    }, {capture: true, once: true});
  });
  await page.mouse.click(box.x + Math.min(80, box.width / 2), box.y + Math.min(20, box.height / 2), {button: 'right'});
  await page.waitForFunction(() => globalThis.__fluentReadContextMenuGesture !== null);
  const gesture = await page.evaluate(() => globalThis.__fluentReadContextMenuGesture);
  assert(gesture.isTrusted && gesture.button === 2, `没有收到可信右键事件：${JSON.stringify(gesture)}`);
  if (expectedText !== undefined) assert(gesture.selectedText === expectedText,
    `右键没有保留预期选区：${JSON.stringify({gesture, expectedText})}`);
  // 模拟菜单弹出/失焦造成的原生 Selection 丢失；Escape 表示用户取消，不用于模拟菜单命令。
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const droppedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
  assert(droppedText === '', '菜单专项没有清除活动 Selection');
  return {...gesture, droppedText};
}

async function sendContextMenuMessage(extensionPage, message) {
  return extensionPage.evaluate(message => new Promise((resolve, reject) => {
    chrome.tabs.query({url: 'https://example.com/*'}, tabs => {
      const queryError = chrome.runtime.lastError?.message;
      if (queryError) {reject(new Error(queryError)); return;}
      if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) {
        reject(new Error(`找不到唯一的测试页面：${JSON.stringify(tabs)}`)); return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, {frameId: 0}, response => {
        const messageError = chrome.runtime.lastError?.message;
        if (messageError) reject(new Error(messageError)); else resolve(response);
      });
    });
  }), message);
}

async function sendContextMenuTranslation(extensionPage, action, selectionText) {
  return sendContextMenuMessage(extensionPage, {type: 'contextMenuTranslate', action,
    ...(selectionText === undefined ? {} : {selectionText})});
}

async function captureContextMenuScreenshot(page, screenshot, label, screenshotOptions = {}) {
  await assertBackgroundFocus(`before ${label}`);
  await page.screenshot({path: screenshot, ...screenshotOptions});
  await assertBackgroundFocus(`after ${label}`);
}

async function readContextMenuNoticeLayout(page) {
  return page.locator('#fluent-read-page-notice-host .page-notice').evaluate(notice => {
    const host = notice.getRootNode().host;
    const stack = notice.parentElement;
    const close = notice.querySelector('.notice-close');
    const detail = notice.querySelector('.notice-detail');
    const rect = element => {
      const {x, y, width, height, right, bottom} = element.getBoundingClientRect();
      return {x, y, width, height, right, bottom};
    };
    const style = getComputedStyle(notice);
    const stackStyle = getComputedStyle(stack);
    const closeStyle = getComputedStyle(close);
    return {theme: host.getAttribute('data-fr-theme'), notice: rect(notice), stack: rect(stack), close: rect(close),
      text: detail.textContent, background: style.backgroundColor, borderRadius: style.borderRadius,
      boxShadow: style.boxShadow, stackBackground: stackStyle.backgroundColor,
      stackPadding: [stackStyle.paddingTop, stackStyle.paddingRight, stackStyle.paddingBottom, stackStyle.paddingLeft].map(parseFloat),
      closeLabel: close.getAttribute('aria-label'), closeFocused: host.shadowRoot.activeElement === close,
      closeFocusVisible: close.matches(':focus-visible'), closeOutlineWidth: closeStyle.outlineWidth,
      detailClientWidth: detail.clientWidth, detailScrollWidth: detail.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth, documentScrollWidth: document.documentElement.scrollWidth};
  });
}

async function runContextMenuNoticeCases({page, popup, result, readRequestCount}) {
  const previous = await readStoredConfig(popup);
  const requestsBefore = readRequestCount();
  const notice = page.locator('#fluent-read-page-notice-host .page-notice');
  const show = async reason => {
    await activateInputPage(page);
    await page.mouse.move(20, 800);
    const response = await sendContextMenuMessage(popup, {type: 'contextMenuNotice', reason});
    assert(response?.status === 'success', `右键通知未被接受：${JSON.stringify({reason, response})}`);
    await page.locator('#fluent-read-page-notice-host .page-notice.is-visible').waitFor({state: 'visible'});
    await page.waitForTimeout(220);
    return response;
  };
  const assertLayout = (layout, width) => {
    assert(layout.notice.x >= 0 && layout.notice.right <= width && layout.notice.y >= 0,
      `右键提示超出视口：${JSON.stringify(layout)}`);
    assert(layout.close.width >= 28 && layout.close.height >= 28 && layout.closeLabel,
      `右键提示关闭按钮没有完整28px可访问点击区域：${JSON.stringify(layout)}`);
    const shadow = layout.boxShadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    assert(Number.parseFloat(layout.borderRadius) >= 10 && shadow
      && shadow.slice(1).map(Number).every(value => value <= 100)
      && layout.stackPadding.every(value => value >= 10),
    `右键提示缺少圆角、中性阴影或裁切留白：${JSON.stringify(layout)}`);
    assert(layout.detailScrollWidth <= layout.detailClientWidth + 1
      && layout.documentScrollWidth <= layout.documentClientWidth + 1,
    `右键长提示发生横向溢出：${JSON.stringify(layout)}`);
  };
  const closeFromEdge = async layout => {
    // 在按钮左缘单击，证明不只中心的“×”文字可点击。
    await page.mouse.click(layout.close.x + 3, layout.close.y + layout.close.height / 2);
    await notice.waitFor({state: 'detached'});
  };
  await patchStoredConfig(popup, {theme: 'light'});
  await page.waitForTimeout(500);
  const responses = await Promise.all([
    sendContextMenuMessage(popup, {type: 'contextMenuNotice', reason: 'selectionUnavailable'}),
    sendContextMenuMessage(popup, {type: 'contextMenuNotice', reason: 'selectionUnavailable'}),
  ]);
  await notice.waitFor({state: 'visible'});
  const noticeText = await notice.textContent();
  assert(responses.every(response => response?.status === 'success') && await notice.count() === 1
    && noticeText.includes('选区已失效') && noticeText.includes('重新选中文字'),
  `右键失败提示不友好或重复堆叠：${JSON.stringify({responses, noticeText, count: await notice.count()})}`);
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(220);
  const narrowLayout = await readContextMenuNoticeLayout(page);
  assertLayout(narrowLayout, 390);
  const narrowScreenshot = path.join(result.artifactsDir, 'context-menu-notice-narrow.png');
  await captureContextMenuScreenshot(page, narrowScreenshot, 'narrow notice screenshot'); result.screenshots.push(narrowScreenshot);
  await closeFromEdge(narrowLayout);
  result.cases.push({id: 'context-menu.actionable-notice-and-dismissal', status: 'passed',
    responses, noticeText, count: 1, layout: narrowLayout, closeGesture: 'trusted left edge of 28px button', additionalRequests: 0});

  const variants = [];
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 900});
    await patchStoredConfig(popup, {theme});
    await page.waitForTimeout(500);
    await show('unavailable');
    const layout = await readContextMenuNoticeLayout(page);
    assertLayout(layout, width);
    assert(layout.theme === theme && layout.text.includes('页面加载完成') && layout.text.includes('扩展更新'),
      `右键提示主题或长文案未同步：${JSON.stringify(layout)}`);
    assert(theme === 'light' ? layout.background === 'rgb(255, 255, 255)' : layout.background !== 'rgb(255, 255, 255)',
      `右键提示没有切换${theme}主题背景：${JSON.stringify(layout)}`);
    const screenshot = path.join(result.artifactsDir, `context-menu-notice-${theme}-${width}.png`);
    await captureContextMenuScreenshot(page, screenshot, `${theme} ${width} notice screenshot`); result.screenshots.push(screenshot);
    let compactScreenshot;
    let compactClip;
    if (theme === 'light' && width === 1280) {
      // 直接截取浏览器像素，保留卡片四周阴影留白，方便用户评估通知外观。
      const viewport = page.viewportSize();
      const x = Math.max(0, Math.floor(layout.notice.x - 20));
      const y = Math.max(0, Math.floor(layout.notice.y - 20));
      compactClip = {x, y, width: Math.min(viewport.width, Math.ceil(layout.notice.right + 20)) - x,
        height: Math.min(viewport.height, Math.ceil(layout.notice.bottom + 20)) - y};
      compactScreenshot = path.join(result.artifactsDir, 'context-menu-notice-light-compact.png');
      await captureContextMenuScreenshot(page, compactScreenshot, 'compact light notice screenshot', {clip: compactClip});
      result.screenshots.push(compactScreenshot);
    }
    variants.push({theme, width, layout, screenshot, ...(compactScreenshot ? {compactScreenshot, compactClip} : {})});
    await closeFromEdge(layout);
  }
  result.cases.push({id: 'context-menu.notice-theme-and-long-layout', status: 'passed', variants,
    visualBoundary: 'Neutral shadow, rounding and clipping space checked by DOM; saved screenshots require visual inspection.'});

  await page.setViewportSize({width: 1280, height: 900});
  await patchStoredConfig(popup, {theme: 'light'});
  await page.waitForTimeout(500);
  const hoverStartedMessageAt = Date.now();
  await show('unavailable');
  await page.waitForTimeout(1200);
  const hoverLayout = await readContextMenuNoticeLayout(page);
  // 先核验可信鼠标确实进入通知；失败报告保留命中和离场事件，区分输入前置问题与计时回归。
  const hoverSamples = [];
  result.noticeHoverSamples = hoverSamples;
  await notice.evaluate(node => {
    const events = [];
    const listeners = ['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave'].map(type => {
      const listener = event => {
        if (events.length < 16) events.push({type, isTrusted: event.isTrusted, at: Date.now(),
          relatedTarget: event.relatedTarget instanceof Element ? event.relatedTarget.tagName : null});
      };
      node.addEventListener(type, listener);
      return [type, listener];
    });
    node.__fluentReadHoverObservation = {events, listeners};
  });
  const sampleHover = async () => {
    const sample = await notice.evaluate(node => {
      const {x, y, width, height} = node.getBoundingClientRect();
      const point = {x: x + width / 2, y: y + height / 2};
      const root = node.getRootNode();
      const outer = document.elementFromPoint(point.x, point.y);
      const inner = root.elementFromPoint(point.x, point.y);
      return {at: Date.now(), hovered: node.matches(':hover'), connected: node.isConnected, point,
        outer: outer?.id || outer?.tagName || null, inner: inner?.className || inner?.tagName || null,
        events: node.__fluentReadHoverObservation.events.slice()};
    });
    hoverSamples.push(sample);
    assert(sample.hovered && sample.connected,
      `通知鼠标停留没有建立或中途离开：${JSON.stringify(sample)}`);
  };
  await activateInputPage(page);
  const hoverStartedAt = Date.now();
  await page.mouse.move(hoverLayout.notice.x + hoverLayout.notice.width / 2,
    hoverLayout.notice.y + hoverLayout.notice.height / 2);
  await sampleHover();
  let hoverMoves = 1;
  for (const heldMs of [500, 2000, 6500]) {
    // 后台可见窗口可能收到系统离场事件；用真实小幅移动维持本用例的阅读输入，不合成 DOM 事件。
    while (Date.now() - hoverStartedAt < heldMs) {
      await page.waitForTimeout(Math.min(200, heldMs - (Date.now() - hoverStartedAt)));
      await page.mouse.move(hoverLayout.notice.x + hoverLayout.notice.width / 2 + hoverMoves % 2,
        hoverLayout.notice.y + hoverLayout.notice.height / 2);
      hoverMoves += 1;
    }
    await sampleHover();
  }
  assert(await notice.count() === 1 && await notice.isVisible(), '右键通知在鼠标阅读超过6秒时自动消失');
  const hoverHeldForMs = Date.now() - hoverStartedAt;
  await notice.evaluate(node => {
    for (const [type, listener] of node.__fluentReadHoverObservation.listeners) node.removeEventListener(type, listener);
    delete node.__fluentReadHoverObservation;
  });
  await page.mouse.move(20, 800);
  const mouseLeftAt = Date.now();
  await notice.waitFor({state: 'detached', timeout: 6500});
  const remainingAfterLeaveMs = Date.now() - mouseLeftAt;
  const beforeHoverMs = hoverStartedAt - hoverStartedMessageAt;
  const expectedRemainderMs = 6000 - beforeHoverMs;
  assert(remainingAfterLeaveMs >= expectedRemainderMs - 500 && remainingAfterLeaveMs <= expectedRemainderMs + 850,
    `鼠标离开后未按剩余阅读时间关闭：${JSON.stringify({beforeHoverMs, hoverHeldForMs, remainingAfterLeaveMs, expectedRemainderMs})}`);
  result.cases.push({id: 'context-menu.notice-hover-pauses-and-resumes', status: 'passed',
    durationMs: 6000, beforeHoverMs, hoverHeldForMs, remainingAfterLeaveMs, expectedRemainderMs,
    inputMode: 'trusted-small-mouse-moves-inside-notice', hoverMoves, hoverSamples});

  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'context-menu-notice-focus-origin';
    button.textContent = 'Fixture keyboard focus origin';
    button.style.cssText = 'position:fixed;left:40px;top:700px;width:260px;height:40px';
    document.body.append(button);
  });
  await page.locator('#context-menu-notice-focus-origin').click();
  await show('selectionUnavailable');
  await page.keyboard.press('Escape');
  assert(await notice.count() === 1, '通知在键盘焦点位于外部时错误拦截Escape');
  let tabPresses = 0;
  let focusLayout;
  while (tabPresses < 25) {
    await page.keyboard.press('Tab'); tabPresses += 1;
    focusLayout = await readContextMenuNoticeLayout(page);
    if (focusLayout.closeFocused) break;
  }
  assert(focusLayout?.closeFocused && focusLayout.closeFocusVisible && Number.parseFloat(focusLayout.closeOutlineWidth) >= 2,
    `真实Tab未形成通知关闭按钮的可见焦点：${JSON.stringify({tabPresses, focusLayout})}`);
  const focusedAt = Date.now();
  await page.waitForTimeout(6500);
  assert(await notice.count() === 1 && await notice.isVisible(), '右键通知在键盘阅读超过6秒时自动消失');
  const focusedForMs = Date.now() - focusedAt;
  const focusScreenshot = path.join(result.artifactsDir, 'context-menu-notice-keyboard-focus.png');
  await captureContextMenuScreenshot(page, focusScreenshot, 'keyboard notice screenshot'); result.screenshots.push(focusScreenshot);
  await page.keyboard.press('Escape');
  await notice.waitFor({state: 'detached'});
  const focusReturned = await page.locator('#context-menu-notice-focus-origin').evaluate(button => document.activeElement === button);
  assert(focusReturned, '键盘关闭通知后未恢复到原网页焦点');
  result.cases.push({id: 'context-menu.notice-keyboard-pauses-and-local-escape', status: 'passed',
    durationMs: 6000, tabPresses, focusedForMs, focusLayout, focusReturned, additionalRequests: 0});

  const revivals = [];
  for (const interaction of ['hover', 'focus']) {
    await page.locator('#context-menu-notice-focus-origin').click();
    await show('unavailable');
    await notice.evaluate(node => {globalThis.__fluentReadNoticeBeforeRevival = node;});
    if (interaction === 'hover') {
      const layout = await readContextMenuNoticeLayout(page);
      await page.mouse.click(layout.close.x + layout.close.width / 2, layout.close.y + layout.close.height / 2);
    } else {
      let presses = 0;
      do {await page.keyboard.press('Tab'); presses += 1;}
      while (!(await readContextMenuNoticeLayout(page)).closeFocused && presses < 25);
      assert((await readContextMenuNoticeLayout(page)).closeFocused, '复活用例没有建立真实关闭按钮焦点');
      await page.keyboard.press('Escape');
    }
    const closingAt = Date.now();
    await page.mouse.move(20, 800);
    const response = await sendContextMenuMessage(popup, {type: 'contextMenuNotice', reason: 'unavailable'});
    const updatedAfterMs = Date.now() - closingAt;
    const sameNode = await notice.evaluate(node => node === globalThis.__fluentReadNoticeBeforeRevival);
    assert(response?.status === 'success' && sameNode && await notice.count() === 1,
      `离场期间同key通知没有原地复活：${JSON.stringify({interaction, response, updatedAfterMs, sameNode})}`);
    const originFocused = await page.locator('#context-menu-notice-focus-origin').evaluate(button => document.activeElement === button);
    assert(originFocused, '复活通知保留了已结束的按钮焦点');
    const revivedAt = Date.now();
    await notice.waitFor({state: 'detached', timeout: 7500});
    const closedAfterMs = Date.now() - revivedAt;
    assert(closedAfterMs >= 5600 && closedAfterMs <= 7000,
      `复活通知因残留hover/focus状态未正常倒计时：${JSON.stringify({interaction, closedAfterMs})}`);
    revivals.push({interaction, sameNode, updatedAfterMs, originFocused, closedAfterMs});
  }
  await page.locator('#context-menu-notice-focus-origin').evaluate(button => button.remove());
  assert(readRequestCount() === requestsBefore, '通知外观或交互额外发起了翻译请求');
  result.cases.push({id: 'context-menu.notice-revival-clears-ended-interaction', status: 'passed', revivals, additionalRequests: 0});
  await patchStoredConfig(popup, {theme: previous.theme});
}

async function triggerShortcut(page, label, settleMs = 450) {
  if (label === 'Ctrl') await page.keyboard.press('Control');
  else if (label === 'Alt / Option') await page.keyboard.press('Alt');
  else if (label === 'Shift') await page.keyboard.press('Shift');
  else await page.keyboard.press('F9');
  await page.waitForTimeout(settleMs);
}

// 两点选取使用真实 CDP 鼠标/键盘创建原生选区；只用 DOM Range 读取字形坐标，不代替被测手势。
// 性能探针只装在本次扩展的 isolated world，保留原 API 行为和产品诊断。
async function createClickSelectionPerformanceProbe(context, page, extensionId) {
  const session = await context.newCDPSession(page), worlds = new Map();
  session.on('Runtime.executionContextCreated', ({context: world}) => worlds.set(world.id, world));
  session.on('Runtime.executionContextDestroyed', ({executionContextId}) => worlds.delete(executionContextId));
  await session.send('Runtime.enable');
  let world;
  const deadline = Date.now() + 5000;
  while (!world && Date.now() < deadline) {
    for (const candidate of worlds.values()) {
      if (candidate.auxData?.type !== 'isolated') continue;
      const identity = await session.send('Runtime.evaluate', {contextId: candidate.id,
        expression: 'globalThis.chrome?.runtime?.id || null', returnByValue: true});
      if (identity.result.value === extensionId) {world = candidate; break;}
    }
    if (!world) await page.waitForTimeout(35);
  }
  if (!world) {await session.detach(); throw new Error('性能探针没有找到本次扩展的 isolated world');}
  const evaluate = async expression => {
    const response = await session.send('Runtime.evaluate', {contextId: world.id, expression, returnByValue: true});
    assert(!response.exceptionDetails, `性能探针执行失败：${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value;
  };
  await evaluate(`(${function installProbe() {
    const restorers = [];
    let active = false, sample, observer;
    const isSelectionSelector = selectors => typeof selectors === 'string' && selectors.includes('.fluent-read-bilingual-content')
      && selectors.includes('.fluent-read-retry-wrapper') && selectors.includes('[data-fluent-read-ui]');
    const isSemanticSelector = selectors => typeof selectors === 'string'
      && (selectors.includes('MathJax') || /(^|,)\s*code(?:\s|,|$)/u.test(selectors));
    const isBroadQuery = root => ['before', 'after'].some(suffix => {
      const unrelated = document.getElementById(`click-selection-unrelated-${suffix}`);
      return Boolean(unrelated && (root === document || root === unrelated || root.contains?.(unrelated)));
    });
    const newSample = () => ({querySelectorAllCalls: 0, broadQueryCalls: 0, unrelatedMatches: 0, elementChecks: 0, unrelatedElementChecks: 0,
      semanticQuerySelectorCalls: 0, semanticQuerySelectorAllCalls: 0, semanticBroadQueryCalls: 0,
      semanticUnrelatedMatches: 0, semanticElementChecks: 0, unrelatedSemanticElementChecks: 0, rangeCloneContentsCalls: 0, semanticQueries: [],
      queryRoots: [], eventTrace: [], pointerupAt: null, nativeSelectionMs: null, nativeOperationMs: null,
      nextFrameMs: null, longTasks: []});
    sample = newSample();
    for (const prototype of [Document.prototype, DocumentFragment.prototype, Element.prototype]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'querySelectorAll');
      if (!descriptor?.value) continue;
      const nativeQuery = descriptor.value;
      Object.defineProperty(prototype, 'querySelectorAll', {...descriptor, value: function(selectors) {
        const found = Reflect.apply(nativeQuery, this, [selectors]);
        if (active && isSelectionSelector(selectors)) {
          sample.querySelectorAllCalls += 1;
          const broad = isBroadQuery(this);
          if (broad) sample.broadQueryCalls += 1;
          sample.queryRoots.push({tag: this.nodeName, id: this.id || '', matches: found.length, broad});
          for (const element of found) if (element.closest('[data-click-selection-unrelated]')) sample.unrelatedMatches += 1;
        }
        if (active && isSemanticSelector(selectors)) {
          sample.semanticQuerySelectorAllCalls += 1;
          const broad = isBroadQuery(this);
          if (broad) sample.semanticBroadQueryCalls += 1;
          sample.semanticQueries.push({method: 'querySelectorAll', tag: this.nodeName, id: this.id || '', matches: found.length, broad});
          for (const element of found) if (element.closest('[data-click-selection-unrelated]')) sample.semanticUnrelatedMatches += 1;
        }
        return found;
      }});
      restorers.push(() => Object.defineProperty(prototype, 'querySelectorAll', descriptor));
      const queryDescriptor = Object.getOwnPropertyDescriptor(prototype, 'querySelector');
      const nativeSingleQuery = queryDescriptor.value;
      Object.defineProperty(prototype, 'querySelector', {...queryDescriptor, value: function(selectors) {
        const found = Reflect.apply(nativeSingleQuery, this, [selectors]);
        if (active && isSemanticSelector(selectors)) {
          sample.semanticQuerySelectorCalls += 1;
          const broad = isBroadQuery(this);
          if (broad) sample.semanticBroadQueryCalls += 1;
          sample.semanticQueries.push({method: 'querySelector', tag: this.nodeName, id: this.id || '', matches: found ? 1 : 0, broad});
          if (found?.closest('[data-click-selection-unrelated]')) sample.semanticUnrelatedMatches += 1;
        }
        return found;
      }});
      restorers.push(() => Object.defineProperty(prototype, 'querySelector', queryDescriptor));
    }
    const matchesDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'matches');
    Object.defineProperty(Element.prototype, 'matches', {...matchesDescriptor, value: function(selectors) {
      if (active && isSelectionSelector(selectors)) {
        sample.elementChecks += 1;
        if (this.closest('[data-click-selection-unrelated]')) sample.unrelatedElementChecks += 1;
      }
      if (active && isSemanticSelector(selectors)) {
        sample.semanticElementChecks += 1;
        if (this.closest('[data-click-selection-unrelated]')) sample.unrelatedSemanticElementChecks += 1;
      }
      return Reflect.apply(matchesDescriptor.value, this, [selectors]);
    }});
    restorers.push(() => Object.defineProperty(Element.prototype, 'matches', matchesDescriptor));
    const cloneDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'cloneContents');
    Object.defineProperty(Range.prototype, 'cloneContents', {...cloneDescriptor, value: function(...args) {
      if (active) sample.rangeCloneContentsCalls += 1;
      return Reflect.apply(cloneDescriptor.value, this, args);
    }});
    restorers.push(() => Object.defineProperty(Range.prototype, 'cloneContents', cloneDescriptor));
    const selectionDescriptor = Object.getOwnPropertyDescriptor(Selection.prototype, 'setBaseAndExtent');
    if (!selectionDescriptor?.value) throw new Error('当前浏览器缺少原生 Selection.setBaseAndExtent');
    Object.defineProperty(Selection.prototype, 'setBaseAndExtent', {...selectionDescriptor, value: function(...args) {
      const before = performance.now();
      const value = Reflect.apply(selectionDescriptor.value, this, args);
      if (active && sample.pointerupAt !== null) {
        const observed = sample;
        observed.eventTrace.push({type: 'native-selection-completed', at: performance.now(), scrollY});
        observed.nativeOperationMs = performance.now() - before;
        observed.nativeSelectionMs = performance.now() - observed.pointerupAt;
        requestAnimationFrame(() => {observed.nextFrameMs = performance.now() - observed.pointerupAt;});
      }
      return value;
    }});
    restorers.push(() => Object.defineProperty(Selection.prototype, 'setBaseAndExtent', selectionDescriptor));
    const pointerdown = event => {if (active && event.isTrusted) sample.eventTrace.push({type: 'pointerdown', at: performance.now(), scrollY});};
    const pointerup = event => {
      if (active && event.isTrusted) {
        sample.pointerupAt = performance.now();
        sample.eventTrace.push({type: 'pointerup', at: sample.pointerupAt, scrollY});
      }
    };
    const scrolled = event => {if (active) sample.eventTrace.push({type: 'scroll', at: performance.now(), scrollY, trusted: event.isTrusted});};
    window.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('pointerup', pointerup, true);
    window.addEventListener('scroll', scrolled, true);
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => {
        if (active) sample.longTasks.push(...list.getEntries().map(entry => ({durationMs: entry.duration, startTime: entry.startTime})));
      });
      observer.observe({type: 'longtask'});
    }
    globalThis.__fluentReadClickSelectionProbe = {
      reset() {sample = newSample(); active = true;},
      read() {active = false; return sample;},
      calibrate() {
        sample = newSample(); active = true;
        const selectors = '.fluent-read-bilingual-content,.fluent-read-retry-wrapper,[data-fluent-read-ui],button,input,[role]';
        document.getElementById('selection-test-fixture').querySelectorAll(selectors);
        document.getElementById('click-selection-unrelated-before').firstElementChild.matches(selectors);
        const semanticSelector = 'math, mjx-container, .MathJax, .katex, code';
        document.getElementById('selection-test-fixture').querySelector(semanticSelector);
        document.getElementById('click-selection-unrelated-before').firstElementChild.matches(semanticSelector);
        const selectedOnly = document.createRange(); selectedOnly.selectNodeContents(document.getElementById('target')); selectedOnly.cloneContents();
        active = false; return sample;
      },
      stop() {
        active = false;
        observer?.disconnect(); window.removeEventListener('pointerdown', pointerdown, true); window.removeEventListener('pointerup', pointerup, true);
        window.removeEventListener('scroll', scrolled, true);
        for (const restore of restorers.reverse()) restore();
        delete globalThis.__fluentReadClickSelectionProbe;
      },
    };
    return true;
  }.toString()})()`);
  return {
    world: {id: world.id, origin: world.origin, name: world.name},
    reset: () => evaluate('globalThis.__fluentReadClickSelectionProbe.reset(); true'),
    read: () => evaluate('globalThis.__fluentReadClickSelectionProbe.read()'),
    calibrate: () => evaluate('globalThis.__fluentReadClickSelectionProbe.calibrate()'),
    stop: async () => {try {await evaluate('globalThis.__fluentReadClickSelectionProbe.stop(); true');} finally {await session.detach();}},
  };
}

function summarizeClickSelectionTiming(samples) {
  const values = samples.map(sample => sample.nativeSelectionMs).sort((left, right) => left - right);
  const percentile = fraction => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  return {samples: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95),
    minMs: values[0], maxMs: values.at(-1),
    querySelectorAllCalls: samples.reduce((sum, sample) => sum + sample.querySelectorAllCalls, 0),
    broadQueryCalls: samples.reduce((sum, sample) => sum + sample.broadQueryCalls, 0),
    unrelatedMatches: samples.reduce((sum, sample) => sum + sample.unrelatedMatches, 0),
    elementChecks: samples.reduce((sum, sample) => sum + sample.elementChecks, 0),
    unrelatedElementChecks: samples.reduce((sum, sample) => sum + sample.unrelatedElementChecks, 0),
    semanticQuerySelectorCalls: samples.reduce((sum, sample) => sum + sample.semanticQuerySelectorCalls, 0),
    semanticQuerySelectorAllCalls: samples.reduce((sum, sample) => sum + sample.semanticQuerySelectorAllCalls, 0),
    semanticBroadQueryCalls: samples.reduce((sum, sample) => sum + sample.semanticBroadQueryCalls, 0),
    semanticUnrelatedMatches: samples.reduce((sum, sample) => sum + sample.semanticUnrelatedMatches, 0),
    semanticElementChecks: samples.reduce((sum, sample) => sum + sample.semanticElementChecks, 0),
    unrelatedSemanticElementChecks: samples.reduce((sum, sample) => sum + sample.unrelatedSemanticElementChecks, 0),
    rangeCloneContentsCalls: samples.reduce((sum, sample) => sum + sample.rangeCloneContentsCalls, 0),
    longTaskCount: samples.reduce((sum, sample) => sum + sample.longTasks.length, 0)};
}

async function runClickSelectionCases({page, popup, context, extensionId, result, args, runtimeDiagnostics}) {
  const hotkey = 'Alt+Shift+S';
  const initial = await readStoredConfig(popup);
  assert(initial.selectionClickSelectEnabled === false && initial.selectionClickSelectHotkey === hotkey,
    '新临时配置没有保留两点选取默认关闭及推荐快捷键');
  await patchStoredConfig(popup, {
    on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
    selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0, selectionTranslatorAutoDismiss: false,
    selectionClickSelectEnabled: false, selectionClickSelectHotkey: hotkey,
    from: 'auto', to: 'zh-Hans', hotkey: 'none', floatingBallHotkey: 'none',
    harness: {...initial.harness, enabled: false},
  });
  await resetFixture(page);
  await page.evaluate(() => {
    const main = document.querySelector('#selection-test-fixture');
    main.style.maxWidth = '960px';
    main.insertAdjacentHTML('beforeend', `
      <p id="second">Another paragraph keeps its own words and punctuation for reading.</p>
      <p><a id="click-link" href="#click-result">Follow this link</a>
      <button id="click-button" type="button">Count click</button>
      <input id="click-input" aria-label="Host editor" value="Host input" /></p>
      <p id="click-editable" contenteditable="true">An editable paragraph stays editable.</p>
      <p id="click-long" style="max-width:720px;word-break:break-all;font-size:14px;line-height:1.2"></p>
      <p id="click-protected"><span id="click-protected-before">Words before a control</span><button type="button">Protected action</button><span id="click-protected-after">Words after a control</span></p>
      <div id="click-shadow-editor"></div>
      <p id="click-result">Link target</p>`);
    document.querySelector('#click-long').textContent = 'abcdefghijklmnopqrst'.repeat(260);
    document.querySelector('#click-shadow-editor').attachShadow({mode: 'open'}).innerHTML = '<input aria-label="Shadow host editor" value="Shadow input" />';
    document.querySelector('#click-button').addEventListener('click', () => {
      document.querySelector('#click-button').dataset.clicks = String(Number(document.querySelector('#click-button').dataset.clicks || 0) + 1);
    });
  });
  const text = await page.locator('#target').textContent();
  const secondText = await page.locator('#second').textContent();
  const check = (id, evidence = {}) => result.cases.push({id: `click-selection.${id}`, status: 'passed', ...evidence});
  const state = async () => {
    const {root} = await getSelectionUiTree(page);
    const node = findCdpNode(root, candidate => ['start', 'end'].includes(cdpAttribute(candidate, 'data-click-selection-state')));
    return {state: cdpAttribute(node, 'data-click-selection-state') || 'idle', text: cdpText(node)};
  };
  const waitState = async expected => {
    const deadline = Date.now() + 5000;
    let current;
    do {
      current = await state();
      if (current.state === expected) return current;
      await page.waitForTimeout(35);
    } while (Date.now() < deadline);
    throw new Error(`两点选取应为 ${expected}，实际为 ${JSON.stringify(current)}`);
  };
  const waitAreaSelecting = async expected => {
    const deadline = Date.now() + 10000;
    do {
      const {root} = await getSelectionUiTree(page);
      const selecting = Boolean(findCdpNode(root, node => hasCdpClass(node, 'fr-area-selecting')));
      if (selecting === expected) return;
      await page.waitForTimeout(35);
    } while (Date.now() < deadline);
    throw new Error(`圈选选择阶段没有变为 ${expected}`);
  };
  const selection = () => page.evaluate(() => {
    const current = window.getSelection();
    return {text: current?.toString() || '', collapsed: current?.isCollapsed, anchor: current?.anchorOffset, focus: current?.focusOffset,
      anchorId: current?.anchorNode?.parentElement?.id, focusId: current?.focusNode?.parentElement?.id};
  });
  const point = async (selector, offset, end = false, reveal = false) => {
    const locate = () => page.locator(selector).evaluate((element, {offset, end}) => {
      const node = element.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || offset < 0 || offset >= node.textContent.length) throw new Error('缺少字形坐标');
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const rect = range.getClientRects()[0];
      return {x: rect.left + rect.width * (end ? .9 : .1), y: rect.top + rect.height / 2};
    }, {offset, end});
    let position = await locate();
    if (reveal) {
      await page.evaluate(({y}) => window.scrollBy(0, y - innerHeight / 2), position);
      position = await locate();
    }
    return position;
  };
  const clickText = async (selector, offset, end = false, reveal = false) => {
    const position = await point(selector, offset, end, reveal);
    await page.mouse.click(position.x, position.y);
  };
  const begin = async () => {
    await activateInputPage(page);
    await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.press(hotkey);
    return waitState('start');
  };
  const screenshot = async label => {
    const screenshotPath = path.join(args.artifactsDir, `${label}.png`);
    await page.screenshot({path: screenshotPath}); result.screenshots.push(screenshotPath);
  };

  if (args.clickSelectionStressOnly) {
    runtimeDiagnostics.setPhase('scroll-immediately-before-endpoint-stress-only');
    await patchStoredConfig(popup, {selectionClickSelectEnabled: true}); await page.waitForTimeout(150);
    await page.evaluate(() => {
      const main = document.getElementById('selection-test-fixture');
      for (const suffix of ['before', 'after']) {
        const section = document.createElement('section'); section.id = `click-selection-unrelated-${suffix}`;
        section.dataset.clickSelectionUnrelated = ''; section.style.cssText = 'font:12px/1.2 Arial,sans-serif';
        section.innerHTML = Array.from({length: 2000}, (_, index) => `<div><button>Unrelated ${index}</button><input/><span role="checkbox">Choice</span></div>`).join('');
        if (suffix === 'before') main.insertBefore(section, document.getElementById('target'));
        else document.getElementById('neighbor').after(section);
      }
    });
    const probe = await createClickSelectionPerformanceProbe(context, page, extensionId), samples = [];
    result.scrollRaceDiagnostic = {samples, probeWorld: probe.world};
    try {
      for (let index = 0; index < 20; index++) {
        await begin(); await clickText('#target', 8, false, true); await waitState('end');
        await probe.reset();
        const endpoint = await point('#neighbor', 20, true, true);
        await page.mouse.click(endpoint.x, endpoint.y); await waitState('idle');
        try {await waitForSelectionUi(page, {indicator: true, tooltip: false}, `快速滚动第${index + 1}轮入口`);}
        catch (error) {
          result.scrollRaceDiagnostic.failedSample = {iteration: index + 1, probe: await probe.read(), selected: await selection()};
          await screenshot('click-selection-scroll-race-failure'); throw error;
        }
        samples.push({...await probe.read(), selected: await selection()});
      }
      check('scroll-immediately-before-endpoint-stress-only', {iterations: samples.length});
    } finally {await probe.stop();}
    await assertBackgroundFocus('click selection stress final'); await runtimeDiagnostics.flush(); runtimeDiagnostics.assertClean();
    result.runtimeDiagnostics = runtimeDiagnostics.snapshot(); result.ok = result.consoleErrors.length === 0;
    fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }

  runtimeDiagnostics.setPhase('default-disabled');
  await activateInputPage(page);
  await page.keyboard.press(hotkey);
  await clickText('#target', 0);
  assert((await state()).state === 'idle', '默认关闭时快捷键不应开始选取');
  check('disabled-by-default');

  runtimeDiagnostics.setPhase('settings-persistence');
  let options = await openSelectionOptions(context, extensionId, result);
  await activateInputPage(options);
  await options.getByRole('switch', {name: '两点选取', exact: true}).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-switch " )][1]').click();
  // 开关刚反馈就关闭页面，验证已有配置保存管线能处理短生命周期页面。
  await options.close();
  const persistDeadline = Date.now() + 10000;
  while (!(await readStoredConfig(popup)).selectionClickSelectEnabled) {
    assert(Date.now() < persistDeadline, '两点选取开关关闭设置页后没有持久化');
    await page.waitForTimeout(50);
  }
  options = await openSelectionOptions(context, extensionId, result);
  const reopened = await options.getByRole('switch', {name: '两点选取', exact: true}).getAttribute('aria-checked');
  assert(reopened === 'true', '重新打开设置页后两点选取丢失');
  const optionsShot = path.join(args.artifactsDir, 'click-selection-settings-reopened.png');
  await options.screenshot({path: optionsShot}); result.screenshots.push(optionsShot);
  result.persistenceCases = [{field: 'selectionClickSelectEnabled', before: false, after: true, reopened: true, quickClose: true}];
  result.quickClose = true;
  result.crossPageSync = {optionsToStoredConfig: true, pageShortcut: 'verified below'};
  result.latestWriteWins = 'existing persistence pipeline; this suite checks the new boolean only';
  await options.close();
  await page.waitForTimeout(300);
  check('settings-enable-quick-close-reopen');

  runtimeDiagnostics.setPhase('native-selection-forward-reverse');
  await begin();
  await screenshot('click-selection-start');
  await clickText('#target', 5);
  await waitState('end');
  await screenshot('click-selection-end');
  await clickText('#target', 35, true);
  await waitState('idle');
  let selected = await selection();
  assert(selected.text === text.slice(5, 36) && selected.anchor === 5 && selected.focus === 36,
    `正向选区错误：${JSON.stringify(selected)}`);
  await waitForSelectionUi(page, {indicator: true, tooltip: false}, '两点选取复用原划词图标');
  await screenshot('click-selection-completed');
  check('forward-native-selection-and-existing-entry', {selected});
  result.crossPageSync.pageShortcut = true;
  await begin(); await clickText('#target', 35, true);
  await waitState('end'); selected = await selection();
  assert(selected.collapsed === true && selected.anchor === 36 && selected.focus === 36,
    `重启后第一点未清除旧高亮：${JSON.stringify(selected)}`);
  check('new-anchor-collapses-previous-native-selection', {selected});
  await clickText('#target', 5);
  await waitState('idle'); selected = await selection();
  assert(selected.text === text.slice(5, 36) && selected.anchor === 36 && selected.focus === 5,
    `反向选区错误：${JSON.stringify(selected)}`);
  check('reverse-native-selection', {selected});

  await begin(); await clickText('#target', 8); await clickText('#second', 20, true);
  await waitState('idle'); selected = await selection();
  assert(selected.anchorId === 'target' && selected.focusId === 'second'
    && selected.text.startsWith(text.slice(8)) && selected.text.endsWith(secondText.slice(0, 21)),
    `跨段选区错误：${JSON.stringify(selected)}`);
  check('cross-paragraph', {selected});

  runtimeDiagnostics.setPhase('cancel-and-safe-host-interactions');
  await begin(); await clickText('#target', 4); await page.keyboard.press('Escape');
  await waitState('idle'); check('escape-cancel');
  await begin(); await page.keyboard.press(hotkey); await waitState('idle'); check('shortcut-toggle-cancel');
  await begin(); await page.keyboard.press('PageDown');
  // 浏览器的可信翻页有动画尾段，先等其完成再测试下一轮字形坐标。
  await page.waitForTimeout(500); await waitState('start');
  await page.keyboard.press('a'); await waitState('idle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  check('paging-preserves-mode-and-main-key-cancels');
  await begin(); await clickText('#target', 9); await clickText('#target', 9);
  const samePointHint = await waitState('end');
  assert(samePointHint.text.includes('起点与终点相同，请换一个位置'), `同点点击缺少反馈：${JSON.stringify(samePointHint)}`);
  await clickText('#target', 25, true); await waitState('idle');
  selected = await selection(); assert(selected.text === text.slice(9, 26), '同点点击后没有保留有效起点');
  check('same-point-retry', {hint: samePointHint.text, selected});
  await begin(); await page.mouse.click(8, 30);
  const blankStartHint = await waitState('start');
  assert(blankStartHint.text.includes('未点中文字，请点击起点'), `空白起点缺少反馈：${JSON.stringify(blankStartHint)}`);
  await clickText('#target', 0); await waitState('end'); await page.mouse.click(8, 30);
  const blankEndHint = await waitState('end');
  assert(blankEndHint.text.includes('未点中文字，请点击终点'), `空白终点缺少反馈：${JSON.stringify(blankEndHint)}`);
  await clickText('#target', 15, true); await waitState('idle'); selected = await selection();
  assert(selected.text === text.slice(0, 16), '空白点击提示后没有保留有效起点');
  check('blank-space-keeps-stage', {hints: [blankStartHint.text, blankEndHint.text], selected});
  await begin(); await clickText('#target', 2); await page.keyboard.press('Tab'); await waitState('idle');
  const tabFocus = await page.evaluate(() => ({id: document.activeElement?.id, tag: document.activeElement?.tagName,
    hostControl: document.activeElement?.matches('a[href],button,input,textarea,select,[contenteditable]')}));
  assert(tabFocus.hostControl, `Tab退出后未把焦点交给宿主控件：${JSON.stringify(tabFocus)}`);
  check('tab-cancels-without-trapping-focus', {activeElement: tabFocus});
  for (const selector of ['#click-button', '#click-input', '#click-editable']) {
    await begin(); await page.locator(selector).click(); await waitState('idle');
    if (selector === '#click-button') assert(await page.locator(selector).getAttribute('data-clicks') === '1', '按钮原点击被吞');
    else assert(await page.locator(selector).evaluate(element => document.activeElement === element), '编辑区原焦点被吞');
    check(`host-${selector.slice(1)}-passes-through`);
  }
  await begin(); await page.locator('#click-link').click(); await waitState('idle');
  assert(page.url().endsWith('#click-result'), '两点模式吞掉了链接导航');
  check('host-link-navigation');
  await page.evaluate(() => {window.scrollTo(0, 0); history.replaceState(null, '', '/');});
  await page.locator('#click-shadow-editor input').click(); await page.keyboard.press(hotkey);
  await waitState('idle');
  assert(await page.locator('#click-shadow-editor input').evaluate(element => element.getRootNode().activeElement === element), '两点快捷键抢走 Shadow DOM 输入框焦点');
  check('shadow-editor-shortcut-passes-through');
  await page.evaluate(() => window.scrollTo(0, 0));

  runtimeDiagnostics.setPhase('dynamic-source-scroll-and-limits');
  await begin(); await clickText('#target', 4);
  await page.locator('#target').evaluate(element => {element.firstChild.replaceWith(document.createTextNode(element.textContent));});
  await clickText('#second', 15); await waitState('idle');
  assert((await selection()).text === '', '已移除的起点被复用');
  check('replaced-anchor-cancels');
  await begin(); await clickText('#target', 3);
  await page.evaluate(() => window.scrollBy(0, 160));
  await clickText('#second', 30, true); await waitState('idle'); selected = await selection();
  assert(selected.anchorId === 'target' && selected.focusId === 'second', '滚动使有效起点丢失');
  check('scroll-between-clicks', {selected});
  await page.evaluate(() => window.scrollTo(0, 0));
  await begin(); await clickText('#click-long', 0, false, true); await clickText('#click-long', 4500, true, true);
  assert((await selection()).text.length <= 4096, '超过4096字符的选区没有被拒绝');
  const longHint = await waitState('end');
  assert(longHint.text.includes('选区过长，请点击较近的终点'), `长选区缺少反馈：${JSON.stringify(longHint)}`);
  await clickText('#click-long', 30, true, true); await waitState('idle'); selected = await selection();
  assert(selected.text.length === 31 && selected.anchor === 0 && selected.focus === 31, '过长拒绝后未保留起点供重试');
  check('long-range-rejected', {hint: longHint.text, retriedSelection: selected});
  await begin(); await clickText('#click-protected-before', 1, false, true); await clickText('#click-protected-after', 8, true);
  const protectedHint = await waitState('end');
  assert(protectedHint.text.includes('此范围不支持，请换一个终点'), `保护内容缺少反馈：${JSON.stringify(protectedHint)}`);
  await clickText('#click-protected-before', 14, true); await waitState('idle'); selected = await selection();
  assert(selected.anchorId === 'click-protected-before' && selected.focusId === 'click-protected-before' && selected.anchor === 1 && selected.focus === 15,
    `保护内容拒绝后未保留起点：${JSON.stringify(selected)}`);
  check('protected-range-rejected-with-retry', {hint: protectedHint.text, selected});
  await page.evaluate(() => window.scrollTo(0, 0));

  runtimeDiagnostics.setPhase('bounded-selection-performance');
  const probe = await createClickSelectionPerformanceProbe(context, page, extensionId);
  const performanceGroups = [];
  result.clickSelectionPerformance = {probeWorld: probe.world, groups: performanceGroups,
    metric: 'Trusted pointerup capture to native Selection.setBaseAndExtent completion in the extension isolated world; CDP/DOM polling time excluded. Next-frame and long-task observations are diagnostic.',
    acceptance: 'Native range boundaries, zero unrelated-control queries/checks, zero broad formula/code queries and zero plain-range cloneContents are asserted. Test-owned canaries prove the probes see the old broad queries, outside matches and cloneContents. p50/p95 are recorded without a brittle wall-clock gate; small sample counts and fixture-only results do not establish all-site latency.'};
  try {
    const measure = async (id, startSelector, endSelector, repetitions = 9, settleReveal = true) => {
      const samples = [], group = {id, samples, settleReveal};
      performanceGroups.push(group);
      for (let index = 0; index < repetitions; index++) {
        try {
          await begin(); await clickText(startSelector, 8, false, true); await waitState('end');
          if (!settleReveal) await probe.reset();
          const endpoint = await point(endSelector, 20, true, true);
          if (settleReveal) {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await probe.reset();
          }
          await page.mouse.click(endpoint.x, endpoint.y);
          await waitState('idle');
          await waitForSelectionUi(page, {indicator: true, tooltip: false}, `${id} 第${index + 1}轮原生选区入口`);
          await page.waitForTimeout(35);
          const sample = await probe.read(), selected = await selection();
          assert(Number.isFinite(sample.nativeSelectionMs), `${id} 缺少真实 pointerup 到原生选区测量：${JSON.stringify(sample)}`);
          const expected = await page.evaluate(({startSelector, endSelector}) => ({
            start: document.querySelector(startSelector).firstChild.data.slice(8),
            end: document.querySelector(endSelector).firstChild.data.slice(0, 21),
            same: document.querySelector(startSelector).firstChild.data.slice(8, 21),
          }), {startSelector, endSelector});
          assert(selected.anchorId === startSelector.slice(1) && selected.focusId === endSelector.slice(1)
            && selected.anchor === 8 && selected.focus === 21 && selected.text.length > 0,
            `${id} 第${index + 1}轮原生选区错误：${JSON.stringify(selected)}`);
          assert(startSelector === endSelector ? selected.text === expected.same : selected.text.startsWith(expected.start) && selected.text.endsWith(expected.end),
            `${id} 第${index + 1}轮原生文本错误：${JSON.stringify(selected)}`);
          samples.push({...sample, selected});
        } catch (error) {
          group.failedSample = {iteration: index + 1, probe: await probe.read(), selected: await selection(), error: String(error.stack || error)};
          fs.writeFileSync(path.join(args.artifactsDir, 'click-selection-performance-failure.json'), `${JSON.stringify(result.clickSelectionPerformance, null, 2)}\n`);
          await screenshot('click-selection-performance-failure');
          throw error;
        }
      }
      group.summary = summarizeClickSelectionTiming(samples);
      return group;
    };
    await measure('short-adjacent-paragraphs', '#target', '#neighbor');
    const unrelatedFixture = await page.evaluate(() => {
      const main = document.getElementById('selection-test-fixture');
      const build = suffix => {
        const container = document.createElement('section');
        container.id = `click-selection-unrelated-${suffix}`; container.dataset.clickSelectionUnrelated = '';
        container.style.cssText = 'font:12px/1.2 Arial,sans-serif';
        container.innerHTML = Array.from({length: 2000}, (_, index) => `<div><button type="button">Unrelated ${suffix} ${index}</button><input aria-label="Unrelated field ${suffix} ${index}"/><span role="checkbox" aria-checked="false">Choice</span></div>`).join('');
        return container;
      };
      main.insertBefore(build('before'), document.getElementById('target'));
      document.getElementById('neighbor').after(build('after'));
      const range = document.createRange(); range.setStart(document.getElementById('target').firstChild, 8); range.setEnd(document.getElementById('neighbor').firstChild, 21);
      return {commonAncestorId: range.commonAncestorContainer.id, unrelatedElements: main.querySelectorAll('[data-click-selection-unrelated] *').length,
        unrelatedControls: main.querySelectorAll('[data-click-selection-unrelated] button,[data-click-selection-unrelated] input,[data-click-selection-unrelated] [role]').length};
    });
    assert(unrelatedFixture.commonAncestorId === 'selection-test-fixture' && unrelatedFixture.unrelatedControls === 12000,
      `大页面未建立 main 共同祖先和前后无关控件：${JSON.stringify(unrelatedFixture)}`);
    const calibration = await probe.calibrate();
    assert(calibration.broadQueryCalls === 1 && calibration.unrelatedMatches === unrelatedFixture.unrelatedControls
      && calibration.unrelatedElementChecks === 1 && calibration.semanticQuerySelectorCalls === 1
      && calibration.semanticBroadQueryCalls === 1 && calibration.unrelatedSemanticElementChecks === 1
      && calibration.rangeCloneContentsCalls === 1, `isolated-world探针未捕获测试自检扫描：${JSON.stringify(calibration)}`);
    const large = await measure('adjacent-paragraphs-with-unrelated-controls', '#target', '#neighbor');
    assert(large.summary.broadQueryCalls === 0 && large.summary.unrelatedMatches === 0 && large.summary.unrelatedElementChecks === 0,
      `短跨段选区仍扫描无关控件：${JSON.stringify(large.summary)}`);
    check('large-page-selection-does-not-scan-unrelated-controls', {fixture: unrelatedFixture, testOwnedProbeCalibration: calibration, timing: large.summary});
    await screenshot('click-selection-large-page');
    const outsideSemantics = await page.evaluate(() => {
      for (const suffix of ['before', 'after']) {
        const container = document.getElementById(`click-selection-unrelated-${suffix}`);
        for (let index = 0; index < container.children.length; index += 10) {
          container.children[index].insertAdjacentHTML('beforeend', '<code data-click-selection-outside-semantic>outside = 1 + 2;</code><span class="MathJax" data-click-selection-outside-semantic>x + y = z</span>');
        }
      }
      return {outsideSemanticNodes: document.querySelectorAll('[data-click-selection-outside-semantic]').length,
        beforeNodes: document.getElementById('click-selection-unrelated-before').querySelectorAll('[data-click-selection-outside-semantic]').length,
        afterNodes: document.getElementById('click-selection-unrelated-after').querySelectorAll('[data-click-selection-outside-semantic]').length};
    });
    assert(outsideSemantics.outsideSemanticNodes === 800 && outsideSemantics.beforeNodes === 400 && outsideSemantics.afterNodes === 400,
      `未在选区前后建立公式与代码节点：${JSON.stringify(outsideSemantics)}`);
    const semanticCalibration = await probe.calibrate();
    assert(semanticCalibration.semanticQuerySelectorCalls === 1 && semanticCalibration.semanticBroadQueryCalls === 1
      && semanticCalibration.semanticUnrelatedMatches === 1 && semanticCalibration.unrelatedSemanticElementChecks === 1
      && semanticCalibration.rangeCloneContentsCalls === 1,
      `公式/代码查询与cloneContents探针自检失败：${JSON.stringify(semanticCalibration)}`);
    const semanticGroup = await measure('adjacent-paragraphs-with-outside-formulas-and-code', '#target', '#neighbor');
    assert(semanticGroup.summary.semanticBroadQueryCalls === 0 && semanticGroup.summary.semanticUnrelatedMatches === 0
      && semanticGroup.summary.unrelatedSemanticElementChecks === 0 && semanticGroup.summary.rangeCloneContentsCalls === 0,
      `选区外公式/代码触发整页查询、遍历或选区克隆：${JSON.stringify(semanticGroup.summary)}`);
    assert(semanticGroup.summary.semanticElementChecks > 0, '没有观测到选区内公式/代码局部检查，无法证明链路已完成');
    check('outside-formulas-and-code-do-not-trigger-scan-or-clone', {fixture: outsideSemantics,
      testOwnedProbeCalibration: semanticCalibration, timing: semanticGroup.summary});
    runtimeDiagnostics.setPhase('scroll-immediately-before-endpoint');
    const quickScroll = await measure('scroll-immediately-before-endpoint', '#target', '#neighbor', 20, false);
    check('scroll-immediately-before-endpoint-keeps-completed-entry', {iterations: quickScroll.samples.length, timing: quickScroll.summary});
    await page.evaluate(() => {
      document.getElementById('click-selection-unrelated-before').remove(); document.getElementById('click-selection-unrelated-after').remove();
      const paragraph = document.createElement('p'); paragraph.id = 'click-single-long';
      paragraph.style.cssText = 'max-width:720px;word-break:break-all;font:14px/1.2 Arial,sans-serif';
      paragraph.textContent = 'abcdefghijklmnopqrst'.repeat(10000);
      document.getElementById('selection-test-fixture').append(paragraph);
    });
    const single = await measure('short-range-in-200000-character-text-node', '#click-single-long', '#click-single-long', 5);
    check('long-single-text-node-short-range', {textNodeLength: 200000, timing: single.summary});
  } finally {
    await probe.stop();
    await page.evaluate(() => {
      for (const id of ['click-selection-unrelated-before', 'click-selection-unrelated-after', 'click-single-long']) document.getElementById(id)?.remove();
      window.scrollTo(0, 0);
    });
  }

  runtimeDiagnostics.setPhase('pointer-session-mutual-exclusion');
  const sectionHost = page.locator('[data-fluent-read-ui="section-picker"]');
  const sectionProfile = {id: 'click-selection-section', enabled: true, action: 'section', hotkey: 'Alt+Shift+R',
    service: 'microsoft', model: '', targetLanguage: 'zh-Hans', displayMode: 'bilingual', fullPageMode: 'inherit'};
  const hoverProfile = {...sectionProfile, id: 'click-selection-hover', action: 'hover', hotkey: 'Alt+Shift+H'};
  await begin();
  await patchStoredConfig(popup, {sectionTranslationHotkeyEnabled: false, quickTranslationProfiles: [sectionProfile, hoverProfile]});
  await page.waitForTimeout(200); await waitState('start');
  await page.keyboard.press(sectionProfile.hotkey);
  await sectionHost.waitFor({state: 'attached'}); await waitState('idle');
  check('section-profile-replaces-click-selection', {sectionHosts: await sectionHost.count()});
  await page.keyboard.press(hotkey);
  await sectionHost.waitFor({state: 'detached'}); await waitState('start');
  await clickText('#target', 3); await waitState('end'); await clickText('#target', 22, true);
  await waitState('idle'); selected = await selection();
  assert(selected.text === text.slice(3, 23) && await sectionHost.count() === 0,
    `两点选取接管局部选择器后未独占手势：${JSON.stringify(selected)}`);
  await page.keyboard.press('Escape'); await waitState('idle');
  assert(await sectionHost.count() === 0, '退出两点选择后仍残留局部选择器');
  check('click-selection-replaces-section-picker', {selected});
  await begin();
  const hoverPoint = await point('#neighbor', 8);
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.keyboard.press(hoverProfile.hotkey); await waitState('idle');
  await page.locator('#neighbor .fluent-read-bilingual-content').waitFor({state: 'attached', timeout: 15000});
  assert(await sectionHost.count() === 0, '悬停方案执行后仍残留局部选择器');
  check('hover-profile-cancels-click-selection', {fixtureTranslation: await page.locator('#neighbor .fluent-read-bilingual-content').innerText()});
  await patchStoredConfig(popup, {quickTranslationProfiles: []});
  await page.waitForTimeout(150);
  await patchStoredConfig(popup, {selectionAreaEnabled: true, selectionAreaHotkey: 'Shift+Z'});
  await page.waitForTimeout(150); await begin();
  await page.keyboard.press('Shift+Z'); await waitState('idle'); await waitAreaSelecting(true);
  check('area-selection-replaces-click-selection');
  await page.keyboard.press(hotkey); await waitAreaSelecting(false); await waitState('start');
  await page.keyboard.press('Escape'); await waitState('idle'); await waitAreaSelecting(false);
  assert(await sectionHost.count() === 0, '圈选与两点选取切换后仍残留局部选择器');
  check('click-selection-replaces-area-selection');
  await patchStoredConfig(popup, {selectionAreaEnabled: false});
  await page.waitForTimeout(150);

  runtimeDiagnostics.setPhase('disable-unmount-and-native-drag');
  await begin(); await clickText('#target', 2);
  await patchStoredConfig(popup, {selectionClickSelectEnabled: false});
  await waitState('idle'); await page.keyboard.press(hotkey); await waitState('idle');
  check('config-disable-cancels');
  const start = await point('#target', 0), end = await point('#target', 20, true);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, {steps: 8}); await page.mouse.up();
  selected = await selection(); assert(selected.text === text.slice(0, 21), `普通拖选回归：${JSON.stringify(selected)}`);
  check('ordinary-drag-selection', {selected});
  await patchStoredConfig(popup, {selectionClickSelectEnabled: true});
  await page.waitForTimeout(150); await begin(); await clickText('#target', 2);
  await patchStoredConfig(popup, {disableSelectionTranslator: true, selectionTranslatorMode: 'disabled'});
  await page.locator('#fluent-read-selection-translator-container').waitFor({state: 'detached'});
  await page.keyboard.press(hotkey); check('feature-unmount');
  await assertBackgroundFocus('click selection final');
  await runtimeDiagnostics.flush(); runtimeDiagnostics.assertClean();
  result.runtimeDiagnostics = runtimeDiagnostics.snapshot();
  result.providerEvidence = 'Production extension in temporary isolated Edge, trusted CDP input and native Selection. Pointer-session takeover uses a local Microsoft HTTP response fixture for the hover profile; no live-provider, system shortcut, Firefox, Safari, mobile hardware or cross-frame selection claim.';
  result.ok = result.consoleErrors.length === 0;
  assert(result.ok, `两点选取控制台异常：${JSON.stringify(result.consoleErrors)}`);
  fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}


function documentShellFixture() {
  // 只保留问题需要的根标记与响应结构，不含用户提供的会话内容、资源或页面脚本。
  return `<!doctype html><html lang="zh-CN" class="notranslate" translate="no"><head><meta charset="utf-8">
    <title>DeepSeek document shell regression fixture</title></head><body>
    <div id="root"><main id="selection-test-fixture" style="padding:48px;font:22px/1.5 Arial,sans-serif">
      <div class="ds-markdown ds-assistant-message-main-content">
        <p id="target">This readable answer needs a selection translation.</p>
        <p id="neighbor">This neighboring answer must remain untouched.</p>
        <p class="notranslate" id="protected-class">Protected local answer text.</p>
        <p translate="no" id="protected-translate">Protected local translation marker.</p>
        <p data-notranslate="true" id="protected-data">Protected local data marker.</p>
        <p contenteditable="true" id="editor">Editable draft content remains private.</p>
        <p role="button" id="control">Interactive action remains unchanged.</p>
      </div>
    </main></div></body></html>`;
}

async function runDocumentShellCases({page, popup, result, args, runtimeDiagnostics, requestCount}) {
  const saved = await readStoredConfig(popup);
  await patchStoredConfig(popup, {
    on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
    selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0, selectionTranslatorAutoDismiss: false,
    to: 'zh-Hans', from: 'auto', service: 'microsoft', useCache: false,
    hotkey: 'none', floatingBallHotkey: 'none', theme: 'light',
    harness: {...saved.harness, enabled: false},
  });
  await page.waitForTimeout(500);
  const hostMarkup = () => page.locator('#root').evaluate(element => element.outerHTML);
  const initialMarkup = await hostMarkup();
  fs.writeFileSync(path.join(args.artifactsDir, 'document-shell-initial.html'), initialMarkup);
  const markerState = () => page.evaluate(() => [document.documentElement, document.body].map(element => ({
    class: element.getAttribute('class'), translate: element.getAttribute('translate'), data: element.getAttribute('data-notranslate'),
  })));
  const selectNative = async () => {
    await closeSelectionUi(page);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const selection = await tripleClickTarget(page);
    assert(selection.mouseDown?.isTrusted && selection.text.includes('readable answer'),
      `文档外壳测试没有建立可信原生选区：${JSON.stringify(selection)}`);
    return selection;
  };
  const translateNative = async (id, trigger) => {
    runtimeDiagnostics.setPhase(id);
    await patchStoredConfig(popup, {selectionTranslatorTrigger: trigger});
    await page.waitForTimeout(300);
    const before = await hostMarkup();
    const markers = await markerState();
    const selection = await selectNative();
    if (trigger === 'icon') {
      await waitForSelectionUi(page, {indicator: true, tooltip: false}, `${id} 图标出现`);
      await clickSelectionIndicator(page);
    } else if (trigger === 'Control') {
      const beforeKey = await readSelectionUi(page);
      assert(!beforeKey.indicator && !beforeKey.tooltip, `${id} 在快捷键按下前已经出现划词 UI`);
      await page.keyboard.down('Control'); await page.keyboard.up('Control');
    }
    await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, `${id} 译文出现`);
    const ui = await readSelectionUi(page);
    assert(ui.resultText.includes(selection.text), `${id} 翻译请求没有保留选区正文`);
    assert(await hostMarkup() === before && JSON.stringify(await markerState()) === JSON.stringify(markers), `${id} 改写了宿主 DOM 或禁译标记`);
    const ownership = await page.evaluate(() => {
      const hosts = document.querySelectorAll('#fluent-read-selection-translator-container');
      return {count: hosts.length, closed: hosts[0]?.shadowRoot === null};
    });
    assert(ownership.count === 1 && ownership.closed, `${id} 划词 Shadow UI 所有权错误`);
    result.cases.push({id, status: 'passed', selection, markers, ownership, ui});
    return ui;
  };

  for (const surface of ['html', 'body', 'both']) {
    runtimeDiagnostics.setPhase(`markers.${surface}`);
    await closeSelectionUi(page);
    await page.evaluate(surface => {
      for (const element of [document.documentElement, document.body]) {
        element.classList.remove('notranslate'); element.removeAttribute('translate'); element.removeAttribute('data-notranslate');
      }
      for (const element of surface === 'html' ? [document.documentElement] : surface === 'body' ? [document.body]
        : [document.documentElement, document.body]) {
        element.classList.add('notranslate'); element.setAttribute('translate', 'no');
      }
    }, surface);
    for (const trigger of ['icon', 'direct', 'Control']) await translateNative(`${surface}.${trigger}`, trigger);
  }
  const screenshot = path.join(args.artifactsDir, 'deepseek-document-shell-selection.png');
  await assertBackgroundFocus('document shell screenshot');
  // Playwright 默认隐藏 caret 会给 contenteditable 留下空 style 属性；保持光标以免截图改变宿主。
  await page.screenshot({path: screenshot, caret: 'initial'}); result.screenshots.push(screenshot);

  // 负向用例使用精确 Range，避免控件自身不允许原生拖选令测试虚假通过。
  await patchStoredConfig(popup, {selectionTranslatorTrigger: 'icon'});
  await page.waitForTimeout(300);
  for (const selector of ['#protected-class', '#protected-translate', '#protected-data', '#editor', '#control']) {
    runtimeDiagnostics.setPhase(`protected.${selector.slice(1)}`);
    await closeSelectionUi(page);
    await page.mouse.click(10, 10);
    const beforeRequests = requestCount();
    const selection = await selectTextWithDomRange(page, selector);
    await page.waitForTimeout(500);
    const ui = await readSelectionUi(page);
    assert(selection.text && !ui.indicator && !ui.tooltip && requestCount() === beforeRequests,
      `${selector} 被文档根例外错误放行：${JSON.stringify({selection, ui})}`);
    result.cases.push({id: `protected.${selector.slice(1)}`, status: 'passed', selection, requests: requestCount() - beforeRequests});
  }
  runtimeDiagnostics.setPhase('protected.document-role');
  await closeSelectionUi(page);
  await page.evaluate(() => document.documentElement.setAttribute('role', 'textbox'));
  const beforeRoleRequests = requestCount();
  await selectNative();
  await page.waitForTimeout(500);
  const roleUi = await readSelectionUi(page);
  assert(!roleUi.indicator && !roleUi.tooltip && requestCount() === beforeRoleRequests, '根标记例外错误绕过根节点 textbox 角色');
  result.cases.push({id: 'protected.document-role', status: 'passed', requests: requestCount() - beforeRoleRequests});
  await page.evaluate(() => document.documentElement.removeAttribute('role'));
  await translateNative('dismiss-reselect-after-protection', 'icon');
  const finalMarkup = await hostMarkup();
  fs.writeFileSync(path.join(args.artifactsDir, 'document-shell-final.html'), finalMarkup);
  assert(finalMarkup === initialMarkup, '划词或保护区测试改写了 DeepSeek 正文结构；参见 document-shell-initial/final.html 差异');

  runtimeDiagnostics.setPhase('dynamic-response-replacement');
  await closeSelectionUi(page);
  await page.locator('#target').evaluate(element => {
    const replacement = element.cloneNode(true);
    replacement.textContent = 'This new readable answer supports another selection translation.';
    element.replaceWith(replacement);
  });
  await translateNative('dynamic-response-replacement', 'icon');
  runtimeDiagnostics.setPhase('page-reload');
  await page.reload({waitUntil: 'domcontentloaded'}); await waitForContentScript(page);
  await translateNative('page-reload', 'icon');
  runtimeDiagnostics.setPhase('page-unload');
  await page.goto('about:blank', {waitUntil: 'load'});
  await page.waitForTimeout(300);
  result.cases.push({id: 'page-unload', status: 'passed'});
  await assertBackgroundFocus('document shell final');
  await runtimeDiagnostics.flush(); runtimeDiagnostics.assertClean();
  result.runtimeDiagnostics = runtimeDiagnostics.snapshot();
  result.providerEvidence = 'Production extension in temporary isolated Edge, native trusted triple-click selections and closed Shadow UI; sanitized DeepSeek-shaped DOM at chat.deepseek.com with local Microsoft HTTP translation responses. Protected-region probes use explicit DOM Ranges. This does not establish live DeepSeek login/streaming behavior, online-provider quality, Firefox or Safari runtime acceptance.';
  result.ok = result.cases.every(item => item.status === 'passed') && result.consoleErrors.length === 0;
  assert(result.ok, `文档根划词专项诊断未通过：${JSON.stringify(result.consoleErrors)}`);
  fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  const { chromium } = loadPlaywright(args.playwrightRoot);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-selection-trigger-edge-'));
  assertDedicatedProfile(profileDir);
  let context;
  let closeBrowser;
  let browserStartAttempted = false;
  let primaryError;
  let runtimeDiagnostics;
  const result = {
    ok: false,
    extensionDir: args.extensionDir,
    artifactsDir: args.artifactsDir,
    browser: 'Microsoft Edge',
    testScope: args.documentShellOnly ? 'document-shell-only' : args.clickSelectionStressOnly ? 'click-selection-scroll-race-only' : args.clickSelectionOnly ? 'click-selection-only' : args.lifecycleOnly ? 'selection-host-lifecycle-only'
      : args.contextMenuOnly ? 'context-menu-only' : 'selection-trigger-filter-or-matrix',
    profileMode: 'temporary-isolated',
    windowMode: args.headed ? 'headed-dedicated-profile' : 'background-visible-no-focus',
    cases: [],
    screenshots: [],
    consoleErrors: [],
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
  };
  let translationRequestCount = 0;
  const translationRequestBatchSizes = [];
  const translationRequestEvents = [];
  let translationResponseDelayMs = 0;
  let translationFailureResponses = 0;
  let expectingProviderFailure = false;
  const recordConsoleIssue = message => {
    if (expectingProviderFailure && /Selection translation error:|翻译失败|\b400\b/.test(message)) {
      (result.expectedConsoleErrors ||= []).push(message);
    } else result.consoleErrors.push(message);
  };
  const inlineCodeRequests = [];
  const translationServer = http.createServer(async (request, response) => {
    const fixtureRequestUrl = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'POST' || fixtureRequestUrl.pathname !== '/translate') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    translationRequestCount += 1;
    translationRequestEvents.push(Date.now());
    let fixtureBody;try {fixtureBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {}
    (result.fixtureRequests ||= []).push({body: fixtureBody, controlledFailure: translationFailureResponses > 0});
    if (translationResponseDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, translationResponseDelayMs));
    }
    if (translationFailureResponses > 0) {
      translationFailureResponses -= 1;
      response.writeHead(400, {'access-control-allow-origin': '*', 'content-type': 'application/json'});
      response.end(JSON.stringify({error: 'Controlled context-menu failure'}));
      return;
    }
    let source = '';
    let sources = [];
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      source = Array.isArray(body) ? String(body[0] || '') : String(body?.[0] || body?.text || '');
      sources = Array.isArray(body) ? body.map(String) : [source];
      translationRequestBatchSizes.push(sources.length);
      if (args.inlineCodeOnly) inlineCodeRequests.push(...sources);
    } catch {
      source = '';
    }
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/json; charset=utf-8',
    });
    const directionSuffix = args.directionOnly ? ` [to=${fixtureRequestUrl.searchParams.get('to') || ''}]` : '';
    response.end(JSON.stringify((args.inlineCodeOnly || args.contextMenuOnly ? sources : [source]).map(text => ({ translations: [{ text: args.lifecycleOnly ? `测试译文：这是用于验证划词翻译和界面交互的中文内容，保留选区标识以核对请求归属。原文标识：「${text}」` : `测试译文：${text}${directionSuffix}` }] }))));
  });
  try {
    await new Promise((resolve, reject) => {
      translationServer.once('error', reject);
      translationServer.listen(0, '127.0.0.1', resolve);
    });
    const translationAddress = translationServer.address();
    const translationFixtureUrl = `http://127.0.0.1:${translationAddress.port}/translate`;
    const browserArgs = [
      `--disable-extensions-except=${args.extensionDir}`,
      `--load-extension=${args.extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    browserStartAttempted = true;
    if (!args.headed) {
      const focusSafe = loadFocusSafeBrowser(args.focusSafeHelper);
      const browserSession = await focusSafe.launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath: args.browserPath,
        headless: false,
        background: true,
        browserArgs,
        viewport: { width: 1280, height: 900 },
      });
      guardBrowserClose(browserSession, profileDir);
      closeBrowser = browserSession.close;
      context = browserSession.context;
      createIsolatedPage = () => focusSafe.newPageWithoutForeground(context);
      activateInputPage = page => focusSafe.activateExtensionTabWithoutForeground(context, page);
      if (args.contextMenuOnly || args.lifecycleOnly || args.clickSelectionOnly || args.documentShellOnly) {
        const browserPid = await getGuardedBrowserPid(browserSession);
        result.ownedBrowserPid = browserPid;
        assertBackgroundFocus = async label => {
          const frontmost = await focusSafe.queryMacFrontmostApplication();
          assert(frontmost && Number.isSafeInteger(frontmost.pid) && frontmost.pid > 0
            && Number.isSafeInteger(browserPid) && browserPid > 0 && frontmost.pid !== browserPid,
          `划词专项焦点检查失败：${JSON.stringify({label, frontmost, browserPid})}`);
          (result.focusChecks ||= []).push({label, frontmost, browserFrontmost: false});
        };
        await assertBackgroundFocus('selection startup');
      }
      result.launchMode = browserSession.launchMode;
      result.focusPolicy = browserSession.focusPolicy;
      result.windowPlacement = browserSession.windowPlacement;
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: args.browserPath,
        headless: false,
        args: browserArgs,
        viewport: { width: 1280, height: 900 },
      });
      closeBrowser = () => context.close();
      result.launchMode = 'playwright-headed';
      result.focusPolicy = 'foreground-authorized';
      result.windowPlacement = { mode: 'headed-explicit-foreground', windowState: 'normal', viewport: { width: 1280, height: 900 } };
    }
    if (args.clickSelectionOnly || args.documentShellOnly || args.lifecycleOnly) {
      runtimeDiagnostics = require(path.resolve(args.runtimeDiagnostics)).createRuntimeDiagnostics();
      await runtimeDiagnostics.start(context);
    }
    const {worker, extensionId} = await waitForWorker(context);
    runtimeDiagnostics?.setExtensionId(extensionId);
    const attachWorkerDiagnostics = (target) => {
      target.on('console', (message) => {
        if (!(args.clickSelectionOnly || args.documentShellOnly) || ['error', 'warning', 'warn'].includes(message.type())) {
          recordConsoleIssue(`worker ${message.type()}: ${message.text()}`);
        }
      });
    };
    attachWorkerDiagnostics(worker);
    const installTranslationFixture = (target) => target.evaluate(({fixtureUrl, directionOnly}) => {
      if (globalThis.__fluentReadSelectionFixtureFetchInstalled) return;
      const nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        return requestUrl.startsWith('https://edge.microsoft.com/translate/translatetext')
          ? nativeFetch(directionOnly
            ? `${fixtureUrl}?to=${encodeURIComponent(new URL(requestUrl).searchParams.get('to') || '')}`
            : fixtureUrl, init)
          : nativeFetch(input, init);
      };
      globalThis.__fluentReadSelectionFixtureFetchInstalled = true;
    }, {fixtureUrl: translationFixtureUrl, directionOnly: args.directionOnly});
    await installTranslationFixture(worker);
    context.on('serviceworker', (target) => {
      attachWorkerDiagnostics(target);
      void installTranslationFixture(target).catch((error) => {
        result.consoleErrors.push(`worker fixture install: ${error.message}`);
      });
    });
    result.extensionId = extensionId;

    await context.route(args.documentShellOnly ? 'https://chat.deepseek.com/**' : 'https://example.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: args.documentShellOnly ? documentShellFixture()
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FluentRead selection fixture</title></head><body><main></main></body></html>',
      });
    });
    const popup = await createIsolatedPage(context);
    popup.on('pageerror', (error) => result.consoleErrors.push(`popup pageerror: ${error.message}`));
    popup.on('console', (message) => {
      if (message.type() === 'error' || message.text().includes('保存 popup 设置失败')) {
        result.consoleErrors.push(`popup ${message.type()}: ${message.text()}`);
      }
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await popup.locator('.popup-shell').waitFor({ state: 'visible', timeout: 60000 });
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({ state: 'visible', timeout: 60000 });
    await assertBackgroundRoundTrip(popup);
    // 默认免费翻译会在多个公开接口间均衡分配；固定为本地夹具拦截的微软接口，避免真实网络译文进入断言。
    await patchStoredConfig(popup, {uiLanguageSetupCompleted: true, service: 'microsoft'});
    await popup.reload({waitUntil: 'domcontentloaded'});
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible'});

    const page = await createIsolatedPage(context);
    page.on('pageerror', (error) => result.consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') recordConsoleIssue(`console: ${message.text()}`); });
    await page.goto(args.documentShellOnly ? 'https://chat.deepseek.com/' : 'https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForContentScript(page);

    if (args.documentShellOnly) {
      await runDocumentShellCases({page, popup, result, args, runtimeDiagnostics, requestCount: () => translationRequestCount});
      return;
    }

    if (args.clickSelectionOnly) {
      await runClickSelectionCases({page, popup, context, extensionId, result, args, runtimeDiagnostics});
      return;
    }

    if (args.lifecycleOnly) {
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0, selectionTranslatorAutoDismiss: false,
        to: 'zh-Hans', from: 'auto', service: 'microsoft', useCache: false,
        hotkey: 'none', floatingBallHotkey: 'none', theme: 'light',
        harness: {...saved.harness, enabled: false},
      });
      await page.waitForTimeout(600);
      const hostSelector = '#fluent-read-selection-translator-container';
      const rememberHost = () => page.evaluate(selector => {
        const host = document.querySelector(selector);
        if (!host) throw new Error('划词 host 尚未挂载');
        globalThis.__fluentReadLifecycleHost = host;
        return {closed: host.shadowRoot === null, hosts: document.querySelectorAll(selector).length};
      }, hostSelector);
      const removeHost = () => page.evaluate(() => globalThis.__fluentReadLifecycleHost.remove());
      const waitForSameHost = () => page.waitForFunction(selector => {
        const host = globalThis.__fluentReadLifecycleHost;
        return host?.isConnected && document.querySelector(selector) === host
          && document.querySelectorAll(selector).length === 1;
      }, hostSelector, {timeout: 5000});
      const selectFresh = async text => {
        await activateInputPage(page);
        await closeSelectionUi(page);
        await resetFixture(page);
        if (text) await page.locator('#target').evaluate((element, value) => {element.textContent = value;}, text);
        if (page.viewportSize()?.width <= 480) await page.locator('#selection-test-fixture').evaluate(element => {
          element.style.padding = '20px'; element.style.fontSize = '20px';
        });
        const selection = await tripleClickTarget(page);
        assert(selection.mouseDown?.isTrusted, '生命周期选区没有来自可信鼠标手势');
        await waitForSelectionUi(page, {indicator: true, tooltip: false}, '新选区显示划词图标');
        return selection;
      };
      const keyboardActivate = async className => {
        await activateInputPage(page);
        const {session, root} = await getSelectionUiTree(page);
        const container = findCdpNode(root, node => hasCdpClass(node, className));
        const button = container?.nodeName === 'BUTTON' ? container
          : findCdpNode(container, node => node.nodeName === 'BUTTON');
        assert(button, `找不到键盘操作目标 ${className}`);
        await session.send('DOM.focus', {nodeId: button.nodeId});
        await page.keyboard.press('Enter');
      };
      const screenshot = async name => {
        await assertBackgroundFocus(name);
        const file = path.join(args.artifactsDir, `${name}.png`);
        await page.screenshot({path: file});
        result.screenshots.push(file);
      };

      const firstSelection = await selectFresh();
      const hostState = await rememberHost();
      assert(hostState.closed && hostState.hosts === 1, `初始 host 所有权不唯一：${JSON.stringify(hostState)}`);
      await removeHost();
      await waitForSameHost();
      await waitForSelectionUi(page, {indicator: true}, '删除后同一划词图标恢复');
      await screenshot('selection-lifecycle-icon-restored-light');
      result.cases.push({id: 'lifecycle.icon-host-restored', status: 'passed', selection: firstSelection, hostState});

      const requestsBeforeOpen = translationRequestCount;
      translationResponseDelayMs = 900;
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, loading: true}, '点击恢复入口后显示加载');
      await removeHost();
      await waitForSameHost();
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '在途卡片恢复后完成翻译');
      translationResponseDelayMs = 0;
      assert(translationRequestCount === requestsBeforeOpen + 1, '重新连接卡片重复发起翻译请求');
      await screenshot('selection-lifecycle-card-restored-light');
      result.cases.push({id: 'lifecycle.pending-card-keeps-request', status: 'passed', additionalRequests: 1, ui: await readSelectionUi(page)});

      // 同一选区连续第三次删除停止自动修复；新的可信选区允许再次恢复。
      await removeHost();
      await page.waitForTimeout(300);
      assert(await page.locator(hostSelector).count() === 0, '持续删除 host 时仍无限自动重挂');
      const recoveredSelection = await selectFresh('A fresh selected sentence should restore the translation entry after repeated removal.');
      await waitForSameHost();
      assert(translationRequestCount === requestsBeforeOpen + 1, '新图标尚未点击时重复发起请求');
      result.cases.push({id: 'lifecycle.repeated-removal-is-bounded-and-new-selection-recovers', status: 'passed', selection: recoveredSelection});
      await clearPageSelection(page);
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '空选区收起入口');
      result.cases.push({id: 'lifecycle.empty-selection-cleans-entry', status: 'passed'});

      await selectFresh('A replaced page must discard this pending selection translation.');
      const requestsBeforeReplacement = translationRequestCount;
      translationResponseDelayMs = 1200;
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, loading: true}, '替换正文前保留在途划词请求');
      await page.evaluate(() => {
        const nextBody = document.createElement('body');
        nextBody.innerHTML = '<main><p>New route body</p></main>';
        document.body.replaceWith(nextBody);
      });
      await waitForSameHost();
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '恢复 host 时关闭来源已失效的卡片');
      await page.waitForTimeout(1500);
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '旧来源的迟到响应不能重新打开卡片');
      assert(translationRequestCount === requestsBeforeReplacement + 1, '恢复失效来源的 host 重复发起翻译');
      translationResponseDelayMs = 0;
      await screenshot('selection-lifecycle-source-replaced-cleared');
      result.cases.push({id: 'lifecycle.replaced-source-cancels-late-result', status: 'passed',
        additionalRequests: 1, ui: await readSelectionUi(page),
        scope: 'Actual production Chrome page/body mutation; Safari consumed-native-selection path is verified separately.'});
      await page.evaluate(() => history.pushState({}, '', '/selection-next-route'));
      await page.waitForTimeout(500);
      const nextRouteSelection = await selectFresh('The newly rendered route still supports selection translation.');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '替换 body 和路由后翻译新选区');
      assert(await page.locator(hostSelector).count() === 1, '路由后出现重复划词 host');
      result.cases.push({id: 'lifecycle.body-and-route-replacement', status: 'passed', selection: nextRouteSelection, ui: await readSelectionUi(page)});

      await patchStoredConfig(popup, {disableSelectionTranslator: true, selectionTranslatorMode: 'disabled'});
      await page.locator(hostSelector).waitFor({state: 'detached'});
      const requestsBeforeDisabled = translationRequestCount;
      await resetFixture(page);
      await selectTarget(page);
      await page.waitForTimeout(350);
      assert(await page.locator(hostSelector).count() === 0 && translationRequestCount === requestsBeforeDisabled,
        '禁用期间页面变化或新选区使划词入口复活');
      await patchStoredConfig(popup, {disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual'});
      await page.locator(hostSelector).waitFor({state: 'attached'});
      await selectFresh('Re-enabled selection translation should use one new owner.');
      assert(await page.locator(hostSelector).count() === 1, '重新启用后存在重复实例');
      result.cases.push({id: 'lifecycle.disable-cleanup-and-reenable', status: 'passed', disabledAdditionalRequests: 0});

      translationResponseDelayMs = 900;
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {loading: true}, '取消前请求正在加载');
      await activateInputPage(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1100);
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '取消后的迟到响应不能重开卡片');
      translationResponseDelayMs = 0;
      result.cases.push({id: 'lifecycle.escape-cancels-late-result', status: 'passed'});

      await selectFresh('A failed selection translation can be retried with the keyboard.');
      runtimeDiagnostics?.setPhase('controlled-provider-failure');
      translationFailureResponses = 1;
      expectingProviderFailure = true;
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, error: true, retryButton: true}, '失败后保留明确重试入口');
      await screenshot('selection-lifecycle-error-retry');
      await keyboardActivate('fr-error-state');
      await waitForSelectionUi(page, {tooltip: true, translation: true, error: false, resultPrefix: '测试译文：'}, '键盘重试完成');
      expectingProviderFailure = false;
      runtimeDiagnostics?.setPhase('narrow-followup');
      result.cases.push({id: 'lifecycle.error-and-keyboard-retry', status: 'passed'});

      await patchStoredConfig(popup, {theme: 'dark'});
      await page.setViewportSize({width: 390, height: 844});
      await selectFresh('A narrow dark screen still leaves the translation readable and its actions reachable.');
      await keyboardActivate('fr-selection-indicator');
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '窄屏键盘打开卡片');
      await page.waitForTimeout(250);
      const {session, root} = await getSelectionUiTree(page);
      const card = findCdpNode(root, node => hasCdpClass(node, 'fr-translation-tooltip'));
      const {object} = await session.send('DOM.resolveNode', {nodeId: card.nodeId});
      let layout;
      try {
        const response = await session.send('Runtime.callFunctionOn', {objectId: object.objectId, returnByValue: true,
          functionDeclaration: `function() { const r = this.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,viewportWidth:innerWidth,viewportHeight:innerHeight,dark:this.classList.contains('fr-dark-theme'),background:getComputedStyle(this).backgroundColor,scrollWidth:this.scrollWidth,clientWidth:this.clientWidth}; }`});
        assert(!response.exceptionDetails, '读取窄屏卡片布局失败');
        layout = response.result.value;
      } finally { await session.send('Runtime.releaseObject', {objectId: object.objectId}); }
      assert(layout.dark && layout.x >= 0 && layout.y >= 0 && layout.right <= layout.viewportWidth
        && layout.bottom <= layout.viewportHeight && layout.scrollWidth <= layout.clientWidth + 1,
      `窄屏划词卡片溢出：${JSON.stringify(layout)}`);
      await screenshot('selection-lifecycle-390-dark');
      await page.keyboard.press('Escape');
      await waitForSelectionUi(page, {tooltip: false, indicator: false}, '键盘关闭窄屏卡片');
      result.cases.push({id: 'lifecycle.narrow-dark-keyboard-open-close', status: 'passed', layout,
        focusMethod: 'CDP DOM.focus on the actual closed-shadow button, followed by trusted Enter/Escape'});
      await patchStoredConfig(popup, {disableSelectionTranslator: true, selectionTranslatorMode: 'disabled'});
      await page.locator(hostSelector).waitFor({state: 'detached'});
      await page.waitForTimeout(250);
      await assertBackgroundFocus('selection lifecycle final cleanup');
      result.cases.push({id: 'lifecycle.final-unmount', status: 'passed', hostCount: await page.locator(hostSelector).count()});
      await runtimeDiagnostics?.flush();
      if (runtimeDiagnostics) {result.runtimeDiagnostics = runtimeDiagnostics.snapshot();runtimeDiagnostics.assertClean();}
      result.ok = result.consoleErrors.length === 0;
      assert(result.ok, `划词生命周期控制台异常：${JSON.stringify(result.consoleErrors)}`);
      result.providerEvidence = 'Production extension in isolated desktop Edge; local Microsoft HTTP fixture and controlled host/body mutations. Trusted CDP input (DOM range fallback recorded when needed), real closed Shadow DOM. 390px is desktop viewport emulation, not mobile hardware. No live-provider, Firefox or Safari claim.';
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (args.inlineCodeOnly) {
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0,
        to: 'zh-Hans', from: 'auto', service: 'microsoft', useCache: false,
        hotkey: 'none', floatingBallHotkey: 'none',
        harness: {...saved.harness, enabled: false},
      });
      await page.waitForTimeout(600);
      const select = async (html, partial = false) => {
        await activateInputPage(page);
        await closeSelectionUi(page);
        await resetFixture(page);
        await page.locator('#target').evaluate((target, markup) => {target.innerHTML = markup;}, html);
        await page.mouse.click(30, 30);
        return page.evaluate(partial => {
          const target = document.querySelector('#target');
          const range = document.createRange();
          range.selectNodeContents(target);
          if (partial) {
            range.setStart(target.querySelector('code').firstChild, 2);
            range.setEnd(target.lastChild, target.lastChild.textContent.length - 1);
          }
          const selection = window.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
          return target.innerHTML;
        }, partial);
      };
      const readCodes = async () => {
        const {session, root} = await getSelectionUiTree(page);
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const host = findCdpNode(root, node => cdpAttribute(node, 'id') === 'fluent-read-selection-translator-container');
        const codes = [];
        const walk = node => {
          if (node.nodeName === 'CODE') codes.push(node);
          cdpChildren(node).forEach(walk);
        };
        walk(host);
        const values = [];
        for (const code of codes) {
          const {computedStyle} = await session.send('CSS.getComputedStyleForNode', {nodeId: code.nodeId});
          values.push({text: cdpText(code), attributes: code.attributes,
            font: computedStyle.find(item => item.name === 'font-family')?.value});
        }
        return values;
      };
      const markup = 'Run <code class="host-code" style="color:red"><span>npm  install</span></code> before calling <code>&lt;Widget /&gt;</code> in your application.';
      for (const trigger of ['icon', 'direct', 'Control']) {
        await patchStoredConfig(popup, {selectionTranslatorTrigger: trigger});
        await page.waitForTimeout(300);
        const before = await select(markup);
        if (trigger === 'icon') {
          await waitForSelectionUi(page, {indicator: true, tooltip: false}, '包含行内代码时显示图标');
          await clickSelectionIndicator(page);
        } else if (trigger === 'Control') {
          await page.waitForTimeout(250);
          await page.keyboard.press('Control');
        }
        await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '行内代码段落翻译');
        const codes = await readCodes();
        assert(JSON.stringify(codes.map(code => code.text)) === JSON.stringify(['npm  install', '<Widget />', 'npm  install', '<Widget />']),
          `原文与译文代码内容不一致：${JSON.stringify(codes)}`);
        assert(codes.every(code => code.font.includes('monospace') && !code.attributes.includes('host-code')), '代码格式丢失或宿主属性泄漏');
        assert(await page.locator('#target').evaluate(target => target.innerHTML) === before, '划词翻译改写了宿主 DOM');
        result.cases.push({id: `inline-code.${trigger}`, status: 'passed', codes, ui: await readSelectionUi(page)});
        if (trigger === 'icon') {
          const screenshot = path.join(args.artifactsDir, 'inline-code-card.png');
          await page.screenshot({path: screenshot}); result.screenshots.push(screenshot);
          await clickSelectionCopyButton(page, 'translation');
          await waitForCopyFeedback(page, '已复制译文');
        }
      }
      await patchStoredConfig(popup, {selectionTranslatorTrigger: 'icon'});
      await page.waitForTimeout(300);
      await select('<code>command</code> finishes this sentence.', true);
      await waitForSelectionUi(page, {indicator: true}, '代码内部起始的部分选区');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, translation: true}, '部分选区译文');
      assert((await readCodes()).every(code => code.text === 'mmand'), '部分选区读取了未选中的代码');
      result.cases.push({id: 'inline-code.partial-range', status: 'passed'});
      for (const [id, html] of [
        ['opt-out', 'Read <code translate="no">npm install</code> now.'],
        ['button', 'Read <code><button>npm install</button></code> now.'],
      ]) {
        const requests = translationRequestCount;
        await select(html);
        await page.waitForTimeout(400);
        const ui = await readSelectionUi(page);
        assert(!ui.indicator && !ui.tooltip && translationRequestCount === requests, `排除区被放行：${id}`);
        result.cases.push({id: `inline-code.reject-${id}`, status: 'passed'});
      }
      translationResponseDelayMs = 1000;
      await select('Delayed prose <code>old_code</code> finishes slowly.');
      await waitForSelectionUi(page, {indicator: true}, '延迟翻译入口');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true}, '延迟翻译卡片');
      await select('New paragraph <code>new_code</code> replaces the selection.');
      await waitForSelectionUi(page, {indicator: true}, '新选区入口');
      translationResponseDelayMs = 0;
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '新选区译文');
      await page.waitForTimeout(1300);
      assert((await readCodes()).every(code => code.text === 'new_code'), '迟到响应覆盖了新选区代码');
      result.cases.push({id: 'inline-code.reselection-cancels-old-result', status: 'passed'});
      assert(inlineCodeRequests.length > 0 && inlineCodeRequests.every(text => !/npm|Widget|command|mmand|old_code|new_code/.test(text)),
        `代码被发送给翻译服务：${JSON.stringify(inlineCodeRequests)}`);
      const codeRequestsStart = inlineCodeRequests.length;
      for (const [id, html] of [
        ['code-only', '<code>Explain the selected command</code>'],
        ['pre', '<pre>Explain the selected command</pre>'],
        ['highlighted', '<pre><code><span>Explain</span> the selected command</code></pre>'],
        ['block-code', '<code style="display:block">Explain the selected command</code>'],
      ]) {
        for (const trigger of ['icon', 'direct', 'Control']) {
          await patchStoredConfig(popup, {selectionTranslatorTrigger: trigger});
          await page.waitForTimeout(300);
          const before = await select(html);
          if (trigger === 'icon') {
            await waitForSelectionUi(page, {indicator: true}, '代码选区图标');
            await clickSelectionIndicator(page);
          } else if (trigger === 'Control') {
            await page.waitForTimeout(250);
            await page.keyboard.press('Control');
          }
          await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '代码选区翻译');
          assert(await page.locator('#target').evaluate(target => target.innerHTML) === before, '代码划词修改了宿主 DOM');
          result.cases.push({id: `code-selection.${id}.${trigger}`, status: 'passed'});
        }
      }
      assert(inlineCodeRequests.slice(codeRequestsStart).includes('Explain the selected command'), '主动代码选区未进入翻译请求');
      await closeSelectionUi(page);
      await waitForSelectionUi(page, {tooltip: false, indicator: false}, '关闭后清理卡片');
      assert(result.consoleErrors.length === 0, `浏览器控制台异常：${JSON.stringify(result.consoleErrors)}`);
      result.ok = true;
      result.translationRequests = inlineCodeRequests;
      result.providerEvidence = 'Local Microsoft batch response fixture; selected DOM ranges and trusted CDP input in isolated Edge. Not a Zen/Firefox runtime or live-provider test.';
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (args.scrollOnly) {
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'dot', selectionTranslatorDelay: 0,
        to: 'zh-Hans', from: 'auto', service: 'microsoft',
        hotkey: 'none', floatingBallHotkey: 'none',
        harness: {...saved.harness, enabled: false},
      });
      await page.waitForTimeout(600);
      await page.evaluate(() => { document.body.style.minHeight = '2400px'; });
      await resetFixture(page);
      await selectTextWithDomRange(page, '#target');
      await waitForSelectionUi(page, {indicator: true, tooltip: false}, '滚动前显示划词小点');
      const initialUi = await readSelectionUi(page);
      assert(initialUi.indicatorClass.includes('fr-selection-indicator--dot'), '滚动测试没有使用小点入口');
      const beforeScreenshot = path.join(args.artifactsDir, 'selection-dot-before-scroll.png');
      await page.screenshot({path: beforeScreenshot});
      result.screenshots.push(beforeScreenshot);
      await page.evaluate(() => window.scrollTo(0, 220));
      await page.waitForFunction(() => window.scrollY >= 200);
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '整页滚动后隐藏小点');
      const afterPageScroll = await readSelectionUi(page);
      assert(afterPageScroll.selectionText === initialUi.selectionText, '滚动不应清除网页原生选区');
      const afterScreenshot = path.join(args.artifactsDir, 'selection-dot-after-scroll.png');
      await page.screenshot({path: afterScreenshot});
      result.screenshots.push(afterScreenshot);
      result.cases.push({id: 'scroll.page-hides-dot', status: 'passed', selectionText: afterPageScroll.selectionText});

      await page.evaluate(() => window.scrollTo(0, 0));
      await resetFixture(page);
      await page.evaluate(() => {
        const target = document.querySelector('#target');
        const scroller = document.createElement('div');
        scroller.id = 'selection-nested-scroller';
        scroller.style.cssText = 'height:120px;overflow-y:auto;max-width:900px';
        target.before(scroller);
        scroller.append(target);
        scroller.insertAdjacentHTML('beforeend', '<div style="height:500px"></div>');
      });
      await selectTextWithDomRange(page, '#target');
      await waitForSelectionUi(page, {indicator: true}, '容器滚动前显示划词小点');
      await page.evaluate(() => { document.querySelector('#selection-nested-scroller').scrollTop = 80; });
      await page.waitForFunction(() => document.querySelector('#selection-nested-scroller').scrollTop >= 80);
      await waitForSelectionUi(page, {indicator: false, tooltip: false}, '嵌套容器滚动后隐藏小点');
      result.cases.push({id: 'scroll.nested-container-hides-dot', status: 'passed'});

      await page.evaluate(() => window.scrollTo(0, 0));
      await patchStoredConfig(popup, {selectionTranslatorDelay: 1200});
      await page.waitForTimeout(300);
      await resetFixture(page);
      await selectTextWithDomRange(page, '#target');
      const beforeDelayedScroll = await readSelectionUi(page);
      assert(!beforeDelayedScroll.indicator && !beforeDelayedScroll.tooltip, '延迟期间不应显示划词入口');
      await page.evaluate(() => window.scrollTo(0, 160));
      await page.waitForFunction(() => window.scrollY >= 150);
      await page.waitForTimeout(1400);
      const afterDelayedScroll = await readSelectionUi(page);
      assert(!afterDelayedScroll.indicator && !afterDelayedScroll.tooltip, '滚动后旧选区的延迟小点重新出现');
      result.cases.push({id: 'scroll.cancels-pending-dot', status: 'passed'});

      await page.evaluate(() => window.scrollTo(0, 0));
      await patchStoredConfig(popup, {selectionTranslatorDelay: 0});
      await page.waitForTimeout(300);
      await resetFixture(page);
      await selectTextWithDomRange(page, '#target');
      await waitForSelectionUi(page, {indicator: true}, '打开卡片前显示小点');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '已打开划词卡片');
      const requestsBeforeCardScroll = translationRequestCount;
      await page.evaluate(() => window.scrollTo(0, 220));
      await page.waitForFunction(() => window.scrollY >= 200);
      await page.waitForTimeout(250);
      const afterCardScroll = await readSelectionUi(page);
      assert(afterCardScroll.tooltip && afterCardScroll.translation, '已打开的翻译卡片不应随页面滚动关闭');
      assert(translationRequestCount === requestsBeforeCardScroll, '页面滚动不应重复发起翻译请求');
      result.cases.push({id: 'scroll.keeps-open-card', status: 'passed', requests: translationRequestCount});

      assert(result.consoleErrors.length === 0, `浏览器控制台异常：${JSON.stringify(result.consoleErrors)}`);
      result.ok = true;
      result.providerEvidence = 'Local Microsoft response fixture; scroll and native selection behavior verified in isolated Edge.';
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (args.contextMenuOnly) {
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true,
        disableSelectionTranslator: false,
        selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'icon',
        selectionTranslatorDelay: 0,
        contextMenuEnabled: true,
        contextMenuEntries: {...saved.contextMenuEntries, translateSelection: true, translatePage: true},
        service: 'microsoft',
        useCache: false,
        from: 'auto',
        to: 'zh-Hans',
        hotkey: 'none',
        floatingBallHotkey: 'none',
        harness: {...saved.harness, enabled: false},
      });
      const drawer = await openSelectionDrawer(popup);
      const options = await openSelectionOptions(context, extensionId, result);
      const selectionUi = {popup, drawer, options, storagePage: popup};
      const triggerState = await setSelectionTrigger(selectionUi, '仅右键菜单');
      result.cases.push({id: 'context-menu.setting-and-popup-preview', status: 'passed', triggerState});
      const settingsScreenshot = path.join(args.artifactsDir, 'context-menu-setting.png');
      await captureContextMenuScreenshot(options, settingsScreenshot, 'context-menu settings screenshot');
      result.screenshots.push(settingsScreenshot);

      // Chromium 没有 contextMenus.getAll；以 update 的回调确认 ID 是否由浏览器注册。
      const menuRegistration = await popup.evaluate(async () => {
        const probe = id => new Promise(resolve => {
          chrome.contextMenus.update(id, {}, () => resolve(!chrome.runtime.lastError));
        });
        const deadline = Date.now() + 5000;
        let registered = false;
        while (Date.now() < deadline) {
          registered = await probe('fluent-read:selection:translateSelection');
          if (registered) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return {
          registered,
          oldGroupRegistered: await probe('fluent-read:selection:group'),
        };
      });
      assert(menuRegistration.registered && !menuRegistration.oldGroupRegistered,
        `浏览器原生选区菜单注册异常：${JSON.stringify(menuRegistration)}`);
      result.cases.push({id: 'context-menu.native-selection-entry', status: 'passed', menuRegistration});

      await activateInputPage(page);
      await resetFixture(page);
      const selected = await tripleClickTarget(page);
      assert(selected.mouseDown?.isTrusted && selected.text === TARGET_TEXT,
        `右键专项原生三击选区错误：${JSON.stringify(selected)}`);
      await page.waitForTimeout(500);
      const quietUi = await readSelectionUi(page);
      assert(quietUi.selectionText === TARGET_TEXT && !quietUi.indicator && !quietUi.readingIndicator && !quietUi.tooltip,
        `仅右键菜单模式仍自动弹出划词入口：${JSON.stringify(quietUi)}`);
      const requestsBeforeShortcut = translationRequestCount;
      await page.keyboard.press('Control');
      await page.waitForTimeout(350);
      const afterShortcut = await readSelectionUi(page);
      assert(!afterShortcut.indicator && !afterShortcut.tooltip && translationRequestCount === requestsBeforeShortcut,
        `仅右键菜单模式占用了 Ctrl 或发起了翻译：${JSON.stringify({afterShortcut, translationRequestCount, requestsBeforeShortcut})}`);
      result.cases.push({id: 'context-menu.selection-stays-quiet', status: 'passed', selected, requestsBeforeShortcut, ui: afterShortcut});

      translationResponseDelayMs = 2400;
      const gesture = await captureRightClickAndDropSelection(page, '#target', TARGET_TEXT);
      const requestsBeforeAction = translationRequestCount;
      const actionStartedAt = Date.now();
      const actionResponse = await sendContextMenuTranslation(popup, 'selection', gesture.selectedText);
      assert(actionResponse?.status === 'success', `右键选区翻译消息未被内容脚本接收：${JSON.stringify(actionResponse)}`);
      await waitForSelectionUi(page, {tooltip: true, loading: true, translation: false}, '右键立即加载反馈');
      const loadingShownAfterMs = Date.now() - actionStartedAt;
      const loadingUi = await readSelectionUi(page);
      assert(loadingUi.loadingText.length > 0, `右键加载反馈缺少文字：${JSON.stringify(loadingUi)}`);
      const loadingScreenshot = path.join(args.artifactsDir, 'context-menu-selection-loading.png');
      await captureContextMenuScreenshot(page, loadingScreenshot, 'context-menu loading screenshot');
      result.screenshots.push(loadingScreenshot);
      // 在途时重新打开菜单；可信右键 pointerdown 不能取消已有请求或清空卡片。
      await page.evaluate(() => {
        const range = globalThis.__fluentReadContextMenuNativeRange?.cloneRange();
        if (!range) throw new Error('重复右键缺少原生选区的完整边界');
        const selection = window.getSelection();
        selection?.removeAllRanges(); selection?.addRange(range);
      });
      const repeatedGesture = await captureRightClickAndDropSelection(page, '#target', TARGET_TEXT);
      const reopenedUi = await readSelectionUi(page);
      assert(reopenedUi.tooltip && reopenedUi.loading && !reopenedUi.translation,
        `在途右键使卡片消失、取消或提前完成：${JSON.stringify(reopenedUi)}`);
      const repeatedResponses = await Promise.all([
        sendContextMenuTranslation(popup, 'selection', repeatedGesture.selectedText),
        sendContextMenuTranslation(popup, 'selection', repeatedGesture.selectedText),
      ]);
      assert(repeatedResponses.every(response => response?.status === 'success'),
        `在途重复右键没有复用请求：${JSON.stringify(repeatedResponses)}`);
      await waitForSelectionUi(page, {tooltip: true, translation: true, resultPrefix: '测试译文：'}, '右键翻译卡片');
      const translatedUi = await readSelectionUi(page);
      assert(translatedUi.resultText.includes(TARGET_TEXT), `右键翻译卡片内容错误：${translatedUi.resultText}`);
      assert(translationRequestCount === requestsBeforeAction + 1,
        `右键相同在途选区重复请求：${JSON.stringify({requestsBeforeAction, translationRequestCount})}`);
      result.cases.push({id: 'context-menu.selection-loss-fallback-and-pending-reuse', status: 'passed', gesture,
        repeatedGesture, actionResponse, repeatedResponses, loadingShownAfterMs, loadingUi,
        reopenedUi, requestDispatchAfterMs: translationRequestEvents[requestsBeforeAction] - actionStartedAt,
        fixtureResponseDelayMs: translationResponseDelayMs,
        requests: translationRequestCount - requestsBeforeAction, ui: translatedUi});
      translationResponseDelayMs = 0;
      const completedResponse = await sendContextMenuTranslation(popup, 'selection', TARGET_TEXT);
      await page.waitForTimeout(250);
      const completedUi = await readSelectionUi(page);
      assert(completedResponse?.status === 'success' && completedUi.resultText === translatedUi.resultText
        && translationRequestCount === requestsBeforeAction + 1,
      `完成后重复右键没有复用卡片：${JSON.stringify({completedResponse, completedUi, translationRequestCount})}`);
      result.cases.push({id: 'context-menu.completed-selection-reuse', status: 'passed', completedResponse,
        additionalRequests: 0, ui: completedUi});
      const cardScreenshot = path.join(args.artifactsDir, 'context-menu-selection-card.png');
      await captureContextMenuScreenshot(page, cardScreenshot, 'context-menu card screenshot');
      result.screenshots.push(cardScreenshot);

      await closeSelectionUi(page);
      await clearPageSelection(page);
      await resetFixture(page);
      const retryText = 'Please retry this selected sentence after the translation provider failed.';
      await page.locator('#target').evaluate((target, text) => {target.textContent = text;}, retryText);
      await tripleClickTarget(page);
      const failedGesture = await captureRightClickAndDropSelection(page, '#target', retryText);
      translationFailureResponses = 1;
      expectingProviderFailure = true;
      const requestsBeforeFailure = translationRequestCount;
      const failedResponse = await sendContextMenuTranslation(popup, 'selection', failedGesture.selectedText);
      assert(failedResponse?.status === 'success', `失败夹具没有启动：${JSON.stringify(failedResponse)}`);
      await waitForSelectionUi(page, {tooltip: true, error: true, retryButton: true, loading: false}, '右键失败与可重试反馈');
      const failedUi = await readSelectionUi(page);
      assert(failedUi.errorText.includes('重试'), `失败反馈没有可执行的重试提示：${JSON.stringify(failedUi)}`);
      const failureScreenshot = path.join(args.artifactsDir, 'context-menu-selection-retry.png');
      await captureContextMenuScreenshot(page, failureScreenshot, 'context-menu retry screenshot');
      result.screenshots.push(failureScreenshot);
      const retryResponse = await sendContextMenuTranslation(popup, 'selection', retryText);
      assert(retryResponse?.status === 'success', `失败后的右键重试没有被接收：${JSON.stringify(retryResponse)}`);
      await waitForSelectionUi(page, {tooltip: true, translation: true, error: false, resultPrefix: '测试译文：'}, '失败后的右键重试');
      const retryUi = await readSelectionUi(page);
      assert(retryUi.resultText.includes(retryText) && translationRequestCount === requestsBeforeFailure + 2,
        `失败后未恰好重试一次：${JSON.stringify({retryUi, requestsBeforeFailure, translationRequestCount})}`);
      expectingProviderFailure = false;
      result.cases.push({id: 'context-menu.failed-selection-retry', status: 'passed', failedResponse, retryResponse,
        failedUi, retryUi, requests: translationRequestCount - requestsBeforeFailure});

      // 仅有浏览器提供的 selectionText 不能翻译旧页面或可编辑区域中的文字。
      await closeSelectionUi(page);
      await clearPageSelection(page);
      await resetFixture(page);
      await tripleClickTarget(page);
      const detachedGesture = await captureRightClickAndDropSelection(page, '#target', TARGET_TEXT);
      await page.locator('#target').evaluate(target => target.remove());
      const requestsBeforeRejection = translationRequestCount;
      const detachedResponse = await sendContextMenuTranslation(popup, 'selection', detachedGesture.selectedText);
      assert(detachedResponse?.status === 'failed', `断连右键目标未被拒绝：${JSON.stringify(detachedResponse)}`);
      await resetFixture(page);
      const editableBodySelection = await tripleClickTarget(page);
      assert(editableBodySelection.text === TARGET_TEXT, '可编辑右键保护用例缺少相同文字的正文选区');
      await page.evaluate(text => {
        globalThis.__fluentReadEditableBodyRange = window.getSelection().getRangeAt(0).cloneRange();
        const input = document.createElement('textarea');
        input.id = 'context-menu-private-input'; input.value = text;
        input.style.cssText = 'position:fixed;left:120px;top:120px;width:600px;height:100px';
        // 保留正文 Selection；浏览器菜单提供的 input 原文恰好相同时也不能复用正文 Range。
        document.body.append(input);
      }, TARGET_TEXT);
      const editableGesture = await captureRightClickAndDropSelection(page, '#context-menu-private-input');
      const editableResponse = await sendContextMenuTranslation(popup, 'selection', TARGET_TEXT);
      // 某些宿主会阻止右键 pointerdown 的焦点默认行为，正文 Selection 此时仍可能保留。
      // 明确标注此受控宿主夹具，不能把它当作 Edge 默认聚焦行为。
      await page.evaluate(() => {
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(globalThis.__fluentReadEditableBodyRange.cloneRange());
        const input = document.querySelector('#context-menu-private-input');
        for (const name of ['pointerdown', 'mousedown']) input.addEventListener(name, event => {
          if (event.button === 2) event.preventDefault();
        }, {capture: true});
      });
      const retainedEditableGesture = await captureRightClickAndDropSelection(page, '#context-menu-private-input', TARGET_TEXT);
      const retainedEditableResponse = await sendContextMenuTranslation(popup, 'selection', TARGET_TEXT);
      await page.waitForTimeout(200);
      const rejectedUi = await readSelectionUi(page);
      assert(editableResponse?.status === 'failed' && retainedEditableResponse?.status === 'failed' && !rejectedUi.tooltip
        && translationRequestCount === requestsBeforeRejection,
      `可编辑右键目标被翻译：${JSON.stringify({editableResponse, rejectedUi, requestsBeforeRejection, translationRequestCount})}`);
      await page.locator('#context-menu-private-input').evaluate(input => input.remove());
      result.cases.push({id: 'context-menu.stale-and-editable-target-rejection', status: 'passed',
        detachedResponse, editableResponse, editableBodySelection, editableGesture, retainedEditableGesture,
        retainedEditableResponse, retainedSelectionHostFixture: 'right pointerdown/mousedown preventDefault', additionalRequests: 0});

      await runContextMenuNoticeCases({page, popup, result, readRequestCount: () => translationRequestCount});

      await clearPageSelection(page);
      await resetFixture(page);
      const sourceHtml = await page.locator('#selection-test-fixture').innerHTML();
      const oldNotice = page.locator('#fluent-read-page-notice-host .page-notice');
      const staleNoticeResponse = await sendContextMenuMessage(popup, {type: 'contextMenuNotice', reason: 'selectionUnavailable'});
      await oldNotice.waitFor({state: 'visible'});
      const oldNoticeBox = await oldNotice.boundingBox();
      await page.mouse.move(oldNoticeBox.x + oldNoticeBox.width / 2, oldNoticeBox.y + oldNoticeBox.height / 2);
      const requestsBeforeRejectedActions = translationRequestCount;
      const rejectedSelectionResponse = await sendContextMenuTranslation(popup, 'selection', 'There is no matching live selected text.');
      assert(rejectedSelectionResponse?.status === 'failed' && await oldNotice.count() === 1,
        `失败的右键动作错误关闭现有提示：${JSON.stringify(rejectedSelectionResponse)}`);
      await patchStoredConfig(popup, {on: false});
      await page.waitForTimeout(600);
      const disabledPageResponse = await sendContextMenuTranslation(popup, 'fullPage');
      assert(disabledPageResponse?.status === 'disabled' && await oldNotice.count() === 1
        && translationRequestCount === requestsBeforeRejectedActions,
      `停用的右键动作关闭提示或发起请求：${JSON.stringify({disabledPageResponse, translationRequestCount})}`);
      await patchStoredConfig(popup, {on: true});
      await page.waitForTimeout(600);
      const translateResponse = await sendContextMenuTranslation(popup, 'fullPage');
      assert(translateResponse?.status === 'success', `右键全文动作没有启动：${JSON.stringify(translateResponse)}`);
      await oldNotice.waitFor({state: 'detached', timeout: 1500});
      await page.mouse.move(20, 800);
      await page.waitForFunction(() => ['#target', '#neighbor'].every(selector => document.querySelector(selector)
        ?.querySelectorAll('.fluent-read-bilingual-content').length === 1), undefined, {timeout: 15000});
      const restoreResponse = await sendContextMenuTranslation(popup, 'restore');
      await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length === 0);
      assert(restoreResponse?.status === 'success' && await page.locator('#selection-test-fixture').innerHTML() === sourceHtml,
        `右键恢复没有还原原文：${JSON.stringify(restoreResponse)}`);
      const retranslateResponse = await sendContextMenuTranslation(popup, 'fullPage');
      await page.waitForFunction(() => ['#target', '#neighbor'].every(selector => document.querySelector(selector)
        ?.querySelectorAll('.fluent-read-bilingual-content').length === 1), undefined, {timeout: 15000});
      assert(retranslateResponse?.status === 'success', `恢复后再次右键翻译失败：${JSON.stringify(retranslateResponse)}`);
      const finalRestoreResponse = await sendContextMenuTranslation(popup, 'restore');
      await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length === 0);
      assert(finalRestoreResponse?.status === 'success' && await page.locator('#selection-test-fixture').innerHTML() === sourceHtml,
        '再次右键翻译后恢复未还原原文');
      result.cases.push({id: 'context-menu.page-translate-restore-retranslate', status: 'passed',
        counts: [1, 0, 1, 0], staleNoticeResponse, rejectedSelectionResponse, disabledPageResponse,
        failureNoticeRetainedForRejectedActions: true, oldFailureNoticeClearedOnSuccess: true,
        translateResponse, restoreResponse, retranslateResponse, finalRestoreResponse});
      result.finalConfig = await readStoredConfig(popup);
      await assertBackgroundFocus('context-menu final state');

      result.ok = result.cases.every(item => item.status === 'passed') && result.consoleErrors.length === 0;
      if (!result.ok) throw new Error(`右键菜单浏览器用例出现控制台错误：${JSON.stringify(result.consoleErrors)}`);
      result.providerEvidence = 'Local Microsoft HTTP response fixture; trusted CDP triple-click/right-click input, native menu ID registration, and production content-message route. Browser menu item selection and background contextMenus.onClicked dispatch are not automated; no live-provider or Firefox-runtime claim.';
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (args.directionOnly) {
      const popupActions = await popup.locator('.translate-action').evaluate(element => ({
        buttons: [...element.querySelectorAll('button')].map(button => button.dataset.testid),
        text: element.querySelector('[data-testid="page-translation"]')?.textContent.trim(),
        keycaps: element.querySelectorAll('kbd').length,
        readingEntry: element.querySelectorAll('.learning-entry').length,
        height: element.getBoundingClientRect().height,
      }));
      assert(JSON.stringify(popupActions.buttons) === JSON.stringify(['page-translation', 'section-translation'])
        && popupActions.keycaps === 0 && popupActions.readingEntry === 0 && popupActions.height <= 43
        && !popupActions.text.includes('A↔译'), `独立按钮优化丢失或渐进阅读入口残留：${JSON.stringify(popupActions)}`);
      const popupScreenshot = path.join(args.artifactsDir, 'popup-retained-compact-actions.png');
      await popup.locator('.popup-shell').screenshot({path: popupScreenshot});
      result.screenshots.push(popupScreenshot);
      result.cases.push({id: 'popup.retained-compact-actions-without-study', status: 'passed', layout: popupActions});
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0,
        selectionTranslatorBidirectional: false, to: 'zh-Hans', from: 'auto',
        service: 'microsoft', hotkey: 'none', floatingBallHotkey: 'none',
        harness: {...saved.harness, enabled: false},
      });
      await page.waitForTimeout(600);
      const select = async text => {
        await activateInputPage(page);
        await page.keyboard.press('Escape');
        await resetFixture(page);
        await page.locator('#target').evaluate((element, value) => {element.textContent = value;}, text);
        await page.locator('#target').click();
        await selectTextWithDomRange(page, '#target', 4096);
      };
      await select('你好，世界！');
      await page.waitForTimeout(250);
      assert(!(await readSelectionUi(page)).indicator && !(await readSelectionUi(page)).tooltip, '关闭双向入口时中文选区不应弹出');
      result.cases.push({id:'direction.default-skip',status:'passed'});

      const options = await openSelectionOptions(context, extensionId, result);
      await activateInputPage(options);
      const bidirectionalSwitch = options.locator('.el-switch').filter({has:options.locator('input[aria-label="中英双向划词"]')});
      await bidirectionalSwitch.waitFor({state:'visible'});
      await bidirectionalSwitch.click();
      const saveDeadline = Date.now() + 10000;
      while ((await readStoredConfig(popup)).selectionTranslatorBidirectional !== true && Date.now() < saveDeadline) {
        await options.waitForTimeout(100);
      }
      assert((await readStoredConfig(popup)).selectionTranslatorBidirectional === true, '中英双向划词没有保存');
      result.cases.push({id:'direction.setting-persists',status:'passed'});

      await select('你好，世界！');
      await waitForSelectionUi(page, {indicator:true}, '中文选区显示反向划词图标');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '中文反向翻译卡片');
      const chineseUi = await readSelectionUi(page);
      assert(chineseUi.navigation.present && chineseUi.navigation.close
        && !chineseUi.navigation.standaloneHeader && !chineseUi.navigation.targetLanguageControl
        && chineseUi.brandIcon.present && /^chrome-extension:\/\/[^/]+\/icon\/128\.png$/u.test(chineseUi.brandIcon.src),
        `卡片品牌图标、紧凑导航或关闭入口异常：${JSON.stringify(chineseUi)}`);
      assert(chineseUi.resultText.endsWith('[to=en]'), `中文反向请求没有译为英文：${chineseUi.resultText}`);
      assert(chineseUi.originalText === '你好，世界！', '反向翻译改写了选区原文');
      result.cases.push({id:'direction.chinese-to-english',status:'passed',ui:chineseUi});
      const chineseScreenshot = path.join(args.artifactsDir,'direction-chinese-to-english.png');
      await page.screenshot({path:chineseScreenshot}); result.screenshots.push(chineseScreenshot);

      await bidirectionalSwitch.click();
      const disabledDeadline = Date.now() + 10000;
      while (Date.now() < disabledDeadline) {
        if ((await readStoredConfig(popup)).selectionTranslatorBidirectional === false
          && !(await readSelectionUi(page)).tooltip) break;
        await options.waitForTimeout(100);
      }
      assert((await readStoredConfig(popup)).selectionTranslatorBidirectional === false
        && !(await readSelectionUi(page)).tooltip, '关闭双向入口后，同语言划词卡片应关闭');
      result.cases.push({id:'direction.setting-off-closes-same-language-card',status:'passed'});
      await bidirectionalSwitch.click();
      const reenabledDeadline = Date.now() + 10000;
      while ((await readStoredConfig(popup)).selectionTranslatorBidirectional !== true && Date.now() < reenabledDeadline) {
        await options.waitForTimeout(100);
      }
      assert((await readStoredConfig(popup)).selectionTranslatorBidirectional === true, '重新开启双向划词没有保存');

      await patchStoredConfig(popup, {to:'en'});
      await page.waitForTimeout(600);
      await select('This is a clear English sentence selected for reverse translation.');
      await waitForSelectionUi(page, {indicator:true}, '英文选区显示反向划词图标');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '英文反向翻译卡片');
      const englishUi = await readSelectionUi(page);
      assert(!englishUi.navigation.targetLanguageControl && englishUi.navigation.close,
        `反向翻译卡片恢复了语言按钮或丢失关闭入口：${JSON.stringify(englishUi.navigation)}`);
      assert(englishUi.resultText.endsWith('[to=zh-Hans]'), `英文反向请求没有译为中文：${englishUi.resultText}`);
      result.cases.push({id:'direction.english-to-chinese',status:'passed',ui:englishUi});

      await patchStoredConfig(popup, {to:'zh-Hans'});
      await page.waitForTimeout(600);
      await select('Ceci est une phrase française complète.');
      await waitForSelectionUi(page, {indicator:true}, '法语选区显示划词图标');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '法语默认翻译卡片');
      const beforeSwitch = translationRequestCount;
      await patchStoredConfig(popup, {to:'en'});
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：',resultSuffix:'[to=en]'}, '配置切换英语目标');
      const switchedUi = await readSelectionUi(page);
      assert(translationRequestCount === beforeSwitch + 1,
        `配置切换目标没有重新请求：${JSON.stringify({beforeSwitch,translationRequestCount})}`);
      assert(switchedUi.resultText.endsWith('[to=en]'), `卡片切换没有使用新目标：${switchedUi.resultText}`);
      assert((await readStoredConfig(popup)).to === 'en', '配置切换没有持久化目标语言');
      result.cases.push({id:'direction.config-target-refresh',status:'passed',ui:switchedUi,requests:translationRequestCount-beforeSwitch});
      const switchScreenshot = path.join(args.artifactsDir,'direction-config-switch.png');
      await page.screenshot({path:switchScreenshot}); result.screenshots.push(switchScreenshot);

      await patchStoredConfig(popup, {to:'zh-Hans'});
      await page.waitForTimeout(600);
      translationResponseDelayMs = 700;
      await select('Une autre phrase française pour vérifier les réponses tardives.');
      await waitForSelectionUi(page, {indicator:true}, '延迟响应测试选区入口');
      const beforeRace = translationRequestCount;
      await clickSelectionIndicator(page);
      const raceDeadline = Date.now() + 3000;
      while (translationRequestCount === beforeRace && Date.now() < raceDeadline) await page.waitForTimeout(20);
      assert(translationRequestCount === beforeRace + 1, '切换前的翻译请求没有启动');
      await patchStoredConfig(popup, {to:'en'});
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：',resultSuffix:'[to=en]'}, '配置切换后的翻译响应');
      await page.waitForTimeout(850);
      const raceUi = await readSelectionUi(page);
      assert(raceUi.resultText.endsWith('[to=en]'),
        `旧方向的迟到响应覆盖了新方向：${raceUi.resultText}`);
      result.cases.push({id:'direction.stale-response-isolation',status:'passed',ui:raceUi});
      translationResponseDelayMs = 0;

      assert(result.consoleErrors.length === 0, `浏览器控制台异常：${JSON.stringify(result.consoleErrors)}`);
      result.ok = true;
      result.providerEvidence = 'Local Microsoft response fixture; direction and request isolation verified without a live translation provider.';
      fs.writeFileSync(path.join(args.artifactsDir,'report.json'), `${JSON.stringify(result,null,2)}\n`);
      console.log(JSON.stringify(result,null,2));
      return;
    }

    if (args.geometryOnly || args.zoomOnly) {
      const saved = await readStoredConfig(popup);
      await patchStoredConfig(popup, {
        on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual',
        selectionTranslatorTrigger: 'direct', selectionTranslatorDelay: 0,
        selectionTranslatorAutoDismiss: false,
        to: 'zh-Hans', from: 'auto', service: 'microsoft', hotkey: 'none',
        harness: {...saved.harness, enabled: false},
      });
      await page.waitForTimeout(600);
      const inspect = async (selector, functionDeclaration) => {
        const {session, root} = await getSelectionUiTree(page);
        const card = findCdpNode(root, node => hasCdpClass(node, 'fr-translation-tooltip'));
        assert(card, '划词窗口没有打开');
        const {object} = await session.send('DOM.resolveNode', {nodeId: card.nodeId});
        try {
          const response = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, functionDeclaration,
            arguments: [{value: selector}], returnByValue: true,
          });
          assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
          return response.result.value;
        } finally { await session.send('Runtime.releaseObject', {objectId: object.objectId}); }
      };
      const box = (selector = '') => inspect(selector, `function(selector) {
        const el = selector ? this.querySelector(selector) : this;
        const r = el.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
      }`);
      const gesture = async (selector, dx, dy, release = true) => {
        const r = await box(selector);
        const point = selector === '.fr-study-navigation' ? await inspect(selector, `function(selector) {
          const element = this.querySelector(selector), r = element.getBoundingClientRect();
          const x = r.left + 7 * (r.width / element.offsetWidth), y = r.top + r.height / 2;
          const hit = this.getRootNode().elementFromPoint(x, y);
          if (!hit || !hit.closest('.fr-study-navigation') || hit.closest('button,a,input,textarea,select,[contenteditable]')) throw new Error('Navigation drag point is interactive or obscured');
          return {x,y};
        }`) : {x: r.x + r.width / 2, y: r.y + r.height / 2};
        const {x, y} = point;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, {steps: 12});
        if (release) await page.mouse.up();
        await page.waitForTimeout(150);
        return box();
      };
      const near = (a, b) => Math.abs(a - b) < 2;
      const open = async (text = TARGET_TEXT.repeat(6)) => {
        await activateInputPage(page);
        await page.keyboard.press('Escape');
        await resetFixture(page);
        await page.locator('#target').evaluate((el, value) => { el.textContent = value; }, text);
        await page.locator('#target').click();
        await selectTextWithDomRange(page, '#target', 4096);
        await waitForSelectionUi(page, {tooltip: true}, '打开几何测试卡片');
      };
      const ready = async () => {
        await waitForSelectionUi(page, {resultPrefix: '测试译文：'}, '等待夹具译文');
        await page.waitForTimeout(250);
      };
      const inside = async () => {
        const r = await box();
        const viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
        assert(r.x >= 10 && r.y >= 10 && r.right <= viewport.width - 10 && r.bottom <= viewport.height - 10, `窗口超出视口 ${JSON.stringify({r,viewport})}`);
        return r;
      };
      if (args.zoomOnly) {
        await open(TARGET_TEXT);
        await ready();
        const tabId = await popup.evaluate(async () => {
          const tabs = await chrome.tabs.query({url: 'https://example.com/*'});
          return tabs.find(tab => tab.active)?.id ?? tabs[0]?.id;
        });
        assert(Number.isInteger(tabId), '找不到隔离测试页的 tabId');
        const samples = [];
        for (const factor of [1, 2, 0.5, 1]) {
          await popup.evaluate(({tabId, factor}) => chrome.tabs.setZoom(tabId, factor), {tabId, factor});
          await page.waitForTimeout(450);
          const zoom = await popup.evaluate(tabId => chrome.tabs.getZoom(tabId), tabId);
          const card = await box();
          const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio}));
          samples.push({zoom, card, viewport, screenWidth: card.width * zoom, screenHeight: card.height * zoom});
          await page.screenshot({path: path.join(args.artifactsDir, `selection-zoom-${String(factor).replace('.', '-')}.png`)});
          assert(card.x >= 10 && card.y >= 10 && card.right <= viewport.width - 10 && card.bottom <= viewport.height - 10,
            `缩放后卡片超出视口：${JSON.stringify(samples.at(-1))}`);
        }
        result.cases.push({id: 'geometry.page-zoom', status: process.argv.includes('--observe-only') ? 'observed' : 'passed', samples});
        console.log(JSON.stringify({zoomSamples: samples}, null, 2));
        if (!process.argv.includes('--observe-only')) {
          const expected = samples[0];
          assert(samples.every(sample => Math.abs(sample.screenWidth - expected.screenWidth) < 3
            && Math.abs(sample.screenHeight - expected.screenHeight) < 4),
            `页面缩放改变了卡片屏幕尺寸：${JSON.stringify(samples.map(sample => [sample.screenWidth, sample.screenHeight]))}`);
          await popup.evaluate(({tabId}) => chrome.tabs.setZoom(tabId, 2), {tabId});
          await page.reload({waitUntil: 'domcontentloaded'});
          await waitForContentScript(page);
          await open(TARGET_TEXT);
          await ready();
          const coldZoom = await popup.evaluate(tabId => chrome.tabs.getZoom(tabId), tabId);
          const coldCard = await box();
          assert(coldZoom === 2 && Math.abs(coldCard.width * coldZoom - expected.screenWidth) < 3,
            `预设 200% 缩放后新页面的卡片尺寸不正确：${JSON.stringify({coldZoom, coldCard})}`);
          await page.screenshot({path: path.join(args.artifactsDir, 'selection-zoom-cold-2.png')});
          result.cases.push({id: 'geometry.zoom-before-load', status: 'passed', coldZoom, coldCard});
          const beforeDrag = await box();
          const afterDrag = await gesture('.fr-study-navigation', 60, 20);
          assert(near(afterDrag.x, beforeDrag.x + 60) && near(afterDrag.y, beforeDrag.y + 20), '200% 缩放下卡片拖动失败');
          const afterResize = await gesture('[data-resize-edge="se"]', 40, 20);
          assert(near(afterResize.width, afterDrag.width + 40) && near(afterResize.height, afterDrag.height + 20),
            '200% 缩放下卡片调整大小失败');
          await inside();
          await popup.evaluate(({tabId}) => chrome.tabs.setZoom(tabId, 1), {tabId});
          await page.waitForTimeout(450);
          const afterReset = await box();
          assert(near(afterReset.width, afterResize.width * 2) && near(afterReset.height, afterResize.height * 2),
            '恢复 100% 缩放后手动尺寸没有保持屏幕大小');
          await inside();
          result.cases.push({id: 'geometry.zoom-drag-resize', status: 'passed', beforeDrag, afterDrag, afterResize, afterReset});
        }
        result.ok = result.consoleErrors.length === 0;
        result.screenshots = ['selection-zoom-1.png', 'selection-zoom-2.png', 'selection-zoom-0-5.png', 'selection-zoom-cold-2.png']
          .map(file => path.join(args.artifactsDir, file));
        result.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
        assert(result.ok, '浏览器控制台包含错误');
        return;
      }
      await open();
      await ready();
      const initial = await box();
      const source = (await readSelectionUi(page)).originalText;
      const requests = translationRequestCount;
      const moved = await gesture('.fr-study-navigation', 160, -60);
      assert(near(moved.x, initial.x + 160) && near(moved.y, initial.y - 60), `标题栏拖动失败 ${JSON.stringify({initial,moved})}`);
      const widened = await gesture('[data-resize-edge="se"]', 200, 80);
      assert(near(widened.width, moved.width + 200) && widened.height > moved.height, '右下角缩放失败');
      const wrapped = await inspect('pre', `function() {
        return [...this.querySelectorAll('pre')].map(el => ({client:el.clientWidth,scroll:el.scrollWidth,height:el.getBoundingClientRect().height}));
      }`);
      assert(wrapped.every(r => r.scroll <= r.client + 1), '文字横向溢出');
      assert((await readSelectionUi(page)).originalText === source, '缩放改写了原文');
      await page.screenshot({path:path.join(args.artifactsDir, 'selection-resized.png')});
      result.cases.push({id:'geometry.drag-resize-wrap',status:'passed',initial,moved,widened,wrapped});
      await page.evaluate(() => { document.body.style.minHeight = '2400px'; window.scrollTo(0, 80); });
      await page.waitForTimeout(300);
      let current = await box();
      assert(near(current.x,widened.x) && near(current.y,widened.y) && near(current.width,widened.width), '滚动让卡片跳回选区');
      await clickSelectionCopyButton(page, 'source');
      await waitForCopyFeedback(page, '已复制原文');
      current = await box();
      assert(near(current.x,widened.x) && near(current.width,widened.width), '复制按钮错误触发拖动');
      assert(translationRequestCount === requests, '窗口调整重新请求翻译');
      result.cases.push({id:'geometry.scroll-copy-request-stability',status:'passed'});
      for (const edge of ['nw','n','ne','e','se','s','sw','w']) {
        const before = await box();
        const after = await gesture(`[data-resize-edge="${edge}"]`, edge.includes('w') ? 20 : edge.includes('e') ? -20 : 0, edge.includes('n') ? 15 : edge.includes('s') ? -15 : 0);
        if (edge.includes('w') || edge.includes('e')) assert(near(after.width,before.width-20), `${edge} 横向缩放错误`);
        if (edge.includes('n') || edge.includes('s')) assert(near(after.height,before.height-15), `${edge} 纵向缩放错误`);
        await inside();
      }
      result.cases.push({id:'geometry.eight-resize-directions',status:'passed'});
      // 内容四周的 padding 可拖动，正文自身仍可选择。
      const content = await box('.fr-tooltip-content');
      const beforeBlank = await box();
      await page.mouse.move(content.x + 8, content.y + 8);
      await page.mouse.down();
      await page.mouse.move(content.x + 48, content.y + 28, {steps:8});
      await page.mouse.up();
      await page.waitForTimeout(150);
      const afterBlank = await box();
      assert(near(afterBlank.x,beforeBlank.x+40) && near(afterBlank.y,beforeBlank.y+20), '内容空白处不能拖动');
      const pre = await box('.fr-original-text pre');
      await page.mouse.move(pre.x+4,pre.y+10);
      await page.mouse.down();
      await page.mouse.move(pre.x+160,pre.y+10,{steps:8});
      await page.mouse.up();
      current = await box();
      assert(near(current.x,afterBlank.x) && near(current.y,afterBlank.y), '正文选择触发了拖动');
      const selection = await inspect('', `function(){return this.getRootNode().getSelection()?.toString() || '';}`);
      assert(selection.length > 0, '无法选择卡片正文');
      result.cases.push({id:'geometry.blank-drag-and-text-selection',status:'passed'});
      await gesture('.fr-study-navigation', 2000, 2000);
      await inside();
      await gesture('[data-resize-edge="nw"]', 2000, 2000);
      const minimum = await inside();
      assert(minimum.width >= 279 && minimum.height >= 139, '缩放突破最小尺寸');
      await page.setViewportSize({width:360,height:640});
      await page.waitForTimeout(300);
      await inside();
      await page.screenshot({path:path.join(args.artifactsDir,'selection-narrow.png')});
      result.cases.push({id:'geometry.viewport-and-minimum-bounds',status:'passed',minimum});
      await page.setViewportSize({width:1280,height:900});
      await page.evaluate(() => window.scrollTo(0,0));
      await open(TARGET_TEXT);
      await ready();
      const reopened = await box();
      assert(near(reopened.width,388), '新选区未恢复默认宽度');
      await gesture('.fr-study-navigation', 60, 15, false);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await waitForSelectionUi(page, {tooltip:false}, '拖动中 Esc 关闭');
      await open(TARGET_TEXT + ' The next selection stays usable.');
      await ready();
      await gesture('[data-resize-edge="se"]', 30, 20, false);
      await patchStoredConfig(popup, {disableSelectionTranslator:true, selectionTranslatorMode:'disabled'});
      await page.waitForTimeout(400);
      await page.mouse.up();
      await waitForSelectionUi(page, {tooltip:false}, '缩放中禁用功能');
      await patchStoredConfig(popup, {disableSelectionTranslator:false, selectionTranslatorMode:'bilingual'});
      await page.waitForTimeout(400);
      translationResponseDelayMs = 1400;
      await open(TARGET_TEXT + ' A delayed result should keep the chosen position.');
      const loadingMoved = await gesture('.fr-study-navigation', 60, 20);
      await ready();
      current = await box();
      assert(near(current.x,loadingMoved.x) && near(current.y,loadingMoved.y), '迟到译文覆盖了拖动位置');
      result.cases.push({id:'geometry.close-disable-reopen-and-late-result',status:'passed',reopened});
      await patchStoredConfig(popup, {theme:'dark'});
      await page.waitForTimeout(300);
      await page.screenshot({path:path.join(args.artifactsDir,'selection-dark.png')});
      result.screenshots = ['selection-resized.png','selection-narrow.png','selection-dark.png'].map(file => path.join(args.artifactsDir,file));
      result.ok = result.consoleErrors.length === 0;
      result.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(args.artifactsDir,'report.json'), `${JSON.stringify(result,null,2)}\n`);
      console.log(JSON.stringify(result,null,2));
      assert(result.ok, '浏览器控制台包含错误');
      return;
    }

    if (args.chineseOnly) {
      const saved = await readStoredConfig(popup);
      const configure = async (patch) => {
        await patchStoredConfig(popup, {
          on: true, disableSelectionTranslator: patch.selectionTranslatorMode === 'disabled', selectionTranslatorMode: 'bilingual',
          selectionTranslatorDelay: 0, to: 'zh-Hans', from: 'auto', service: 'microsoft',
          hotkey: 'none', floatingBallHotkey: 'none', ...patch,
        });
        await page.waitForTimeout(600);
      };
      const select = async (text) => {
        await activateInputPage(page);
        await page.keyboard.press('Escape');
        await resetFixture(page);
        await page.locator('#target').evaluate((element, value) => { element.textContent = value; }, text);
        await page.locator('#target').click();
        await selectTextWithDomRange(page, '#target', 4096);
        await page.waitForTimeout(450);
        assert(await page.evaluate(() => window.getSelection()?.toString()) === text, '选区内容不完整');
      };
      await page.evaluate(() => {
        globalThis.__selectionKeyClaims = [];
        document.addEventListener('keydown', event => {
          globalThis.__selectionKeyClaims.push({key: event.key, prevented: event.defaultPrevented});
        });
      });
      for (const mode of [
        {id: 'icon', selectionTranslatorTrigger: 'icon', enabled: false, trigger: 'click'},
        {id: 'dot', selectionTranslatorTrigger: 'dot', enabled: false, trigger: 'click'},
        {id: 'direct', selectionTranslatorTrigger: 'direct', enabled: false, trigger: 'click'},
        {id: 'selection-shortcut', selectionTranslatorTrigger: 'Control', enabled: false, trigger: 'click'},
        {id: 'card-click', selectionTranslatorTrigger: 'icon', enabled: true, trigger: 'click'},
        {id: 'card-hover', selectionTranslatorTrigger: 'hover', enabled: true, trigger: 'hover'},
        {id: 'card-shortcut', selectionTranslatorTrigger: 'Control', enabled: true, trigger: 'shortcut'},
        {id: 'card-only', selectionTranslatorTrigger: 'icon', enabled: true, trigger: 'shortcut', selectionTranslatorMode: 'disabled'},
      ]) {
        await configure({selectionTranslatorTrigger: mode.selectionTranslatorTrigger,
          selectionTranslatorMode: mode.selectionTranslatorMode || 'bilingual',
          harness: {...saved.harness, enabled: mode.enabled, trigger: mode.trigger, customHotkey: 'Alt+R', hoverDelay: 200},
        });
        for (const source of ['你好', '你好，世界！123 🎉', '繁體中文']) {
          const before = translationRequestCount;
          await select(source);
          await page.evaluate(() => { globalThis.__selectionKeyClaims = []; });
          await page.keyboard.press('Control');
          await page.keyboard.press('Alt+r');
          await page.waitForTimeout(350);
          const ui = await readSelectionUi(page);
          const claims = await page.evaluate(() => globalThis.__selectionKeyClaims);
          assert(!ui.indicator && !ui.readingIndicator && !ui.tooltip, `${mode.id} 为中文显示了入口或卡片`);
          assert(translationRequestCount === before, `${mode.id} 为中文发送了翻译请求`);
          assert(claims.every(event => !event.prevented), `${mode.id} 占用了中文选区快捷键`);
          result.cases.push({id: `chinese.${mode.id}.${source}`, status: 'passed', ui, requests: translationRequestCount - before, claims});
        }
      }
      await configure({selectionTranslatorTrigger: 'direct', harness: {...saved.harness, enabled: false}});
      for (const source of ['你好 hello world', 'Hello world']) {
        await select(source);
        await waitForSelectionUi(page, {tooltip: true, translation: true}, '外语或混排仍可翻译');
        result.cases.push({id: `eligible.${source}`, status: 'passed', ui: await readSelectionUi(page)});
      }
      await select('你好');
      assert(!(await readSelectionUi(page)).tooltip, '从外语改选中文后旧卡片未关闭');
      await configure({to: 'en', selectionTranslatorTrigger: 'direct', harness: {...saved.harness, enabled: false}});
      await select('你好世界');
      await waitForSelectionUi(page, {tooltip: true, translation: true}, '中文译成外语仍可用');
      await configure({to: 'zh-Hans'});
      assert(!(await readSelectionUi(page)).tooltip, '改回中文目标后旧卡片未关闭');
      result.cases.push({id: 'target-change-and-selection-replacement', status: 'passed'});
      await configure({selectionTranslatorTrigger: 'icon', harness: {...saved.harness, enabled: true, trigger: 'click'}});
      await select('Hello world');
      assert((await readSelectionUi(page)).indicator, '外语统一划词入口未恢复');
      await select('你好');
      const finalUi = await readSelectionUi(page);
      assert(!finalUi.indicator && !finalUi.readingIndicator && !finalUi.tooltip, '中文统一划词入口未隐藏');
      result.cases.push({id: 'reading-indicator-restores-for-foreign-selection', status: 'passed', ui: finalUi});
      const screenshot = path.join(args.artifactsDir, 'chinese-selection-no-card.png');
      await page.screenshot({path: screenshot}); result.screenshots.push(screenshot);
      assert(result.consoleErrors.length === 0, `浏览器控制台异常：${JSON.stringify(result.consoleErrors)}`);
      result.ok = true;
      result.providerEvidence = 'Local Microsoft response fixture; reading card entry checks do not call an AI model.';
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const drawer = await openSelectionDrawer(popup);
    const optionsPage = await openSelectionOptions(context, extensionId, result);
    const selectionUi = { popup, drawer, options: optionsPage, storagePage: popup };
    await setSelectionEnabled(selectionUi, true);
    await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'attached', timeout: 10000 });
    await setSelectionMode(selectionUi, '双语显示');

    // Popup 抽屉只保留高频模式选择；触发方式、延迟与朗读声音通过底部入口进入完整设置。
    await activateInputPage(popup);
    const popupModes = (await drawer.getByRole('group', { name: '划词翻译模式' }).getByRole('button').allTextContents()).map(label => label.trim());
    assert(JSON.stringify(popupModes) === JSON.stringify(['双语显示', '仅译文']), `Popup 划词模式选项异常：${JSON.stringify(popupModes)}`);
    const popupDetailedControls = {
      delayInputs: await drawer.locator('input[aria-label="划词翻译显示延迟"]').count(),
      triggerChips: await drawer.locator('.selection-trigger-chips').count(),
      hotkeyEditors: await popup.locator('.custom-hotkey-dialog').count(),
    };
    assert(Object.values(popupDetailedControls).every(count => count === 0), `Popup 抽屉仍包含完整设置控件：${JSON.stringify(popupDetailedControls)}`);
    const popupSettingsLink = (await drawer.locator('.drawer-settings-link strong').textContent())?.trim();
    assert(popupSettingsLink === '更多设置', `Popup 划词抽屉缺少完整设置入口：${popupSettingsLink}`);
    const initialPopupState = await readPopupSelectionState(drawer);
    assert(initialPopupState.checked === 'true' && initialPopupState.modes.every(mode => !mode.disabled)
      && initialPopupState.modes.find(mode => mode.label === '双语显示')?.pressed === 'true',
      `Popup 初始启用和双语模式状态错误：${JSON.stringify(initialPopupState)}`);
    assert(await drawer.locator('.interaction-preview').count() === 0, 'Popup 划词抽屉不应包含已移除的触发预览');
    const popupDrawerScreenshot = path.join(args.artifactsDir, 'popup-selection-drawer.png');
    await popup.screenshot({ path: popupDrawerScreenshot });
    result.screenshots.push(popupDrawerScreenshot);
    result.cases.push({ id: 'ui.popup-selection-drawer-quick-controls', status: 'passed', popupModes, popupDetailedControls, popupSettingsLink, initialPopupState });

    await activateInputPage(optionsPage);
    const optionsDelayInput = optionsPage.locator('input[aria-label="划词翻译显示延迟"]');
    try {
      await optionsDelayInput.waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      const [pageDiagnostic, storedConfig] = await Promise.all([
        optionsPage.evaluate(() => ({
          hash: location.hash,
          activeSection: document.querySelector('.sidebar button.active')?.getAttribute('data-section') || '',
          numberInputs: [...document.querySelectorAll('input[type="number"]')].map(input => ({
            ariaLabel: input.getAttribute('aria-label') || '',
            section: input.closest('.settings-section')?.id || '',
            value: input.value,
            visible: Boolean(input.getClientRects().length),
          })),
        })),
        readStoredConfig(optionsPage),
      ]);
      const diagnostic = { ...pageDiagnostic, storedConfig };
      throw new Error(`完整配置页未显示划词翻译延迟控件：${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const initialDelayConfig = await readStoredConfig(popup);
    const initialDelayInput = await optionsDelayInput.inputValue();
    assert(initialDelayConfig.selectionTranslatorDelay === 300 && initialDelayInput === '300',
      `完整配置页没有显示默认 300ms 延迟：${JSON.stringify({ stored: initialDelayConfig.selectionTranslatorDelay, input: initialDelayInput })}`);
    const initialTriggerState = await waitForSelectionTriggerState(selectionUi, '显示图标');
    await setSelectionDelay(selectionUi, 450, 700);
    await optionsPage.reload({ waitUntil: 'domcontentloaded' });
    await optionsDelayInput.waitFor({ state: 'visible', timeout: 15000 });
    assert(await optionsDelayInput.inputValue() === '450', `完整配置页重新打开后延迟值错误：${await optionsDelayInput.inputValue()}`);
    const optionsDelayScreenshot = path.join(args.artifactsDir, 'options-selection-delay.png');
    await optionsPage.screenshot({ path: optionsDelayScreenshot });
    result.screenshots.push(optionsDelayScreenshot);
    result.cases.push({ id: 'ui.options-delay-persistence-and-popup-mode', status: 'passed', configuredDelay: 450, initialTriggerState });
    await setSelectionDelay(selectionUi, 300);

    // 显示延迟：计时期间不显示 UI、不发翻译请求；改选后旧计时器必须失效。
    await setSelectionDelay(selectionUi, 800);
    await setSelectionTrigger(selectionUi, '直接弹出');
    await resetFixture(page);
    await startSelectionUiTracking(page);
    const delayedRequestsBefore = translationRequestCount;
    const delayedSelection = await selectTextWithDomRange(page, '#target');
    await page.waitForTimeout(250);
    const duringDelay = await readSelectionUi(page);
    const delayedSampleElapsed = await page.evaluate(selectedAt => performance.now() - selectedAt, delayedSelection.selectedAt);
    if (delayedSampleElapsed < 650) {
      assert(!duringDelay.indicator && !duringDelay.tooltip, `延迟期间提前显示了划词 UI：${JSON.stringify({ delayedSampleElapsed, duringDelay })}`);
      assert(translationRequestCount === delayedRequestsBefore,
        `延迟期间提前发起了翻译请求：${delayedRequestsBefore} -> ${translationRequestCount}`);
    }
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true, resultPrefix: '测试译文：' }, '延迟结束后直接弹出翻译框');
    const delayedTransitions = await stopSelectionUiTracking(page);
    const delayedVisible = delayedTransitions.find(item => item.tooltip);
    assert(delayedVisible && delayedVisible.at - delayedSelection.selectedWallAt >= 650,
      `划词 UI 显示过早：${JSON.stringify({ selectedWallAt: delayedSelection.selectedWallAt, transitions: delayedTransitions })}`);
    assert(translationRequestCount === delayedRequestsBefore + 1,
      `延迟结束后请求数不是恰好一次：${delayedRequestsBefore} -> ${translationRequestCount}`);
    const delayedRequestAt = translationRequestEvents[delayedRequestsBefore];
    assert(delayedRequestAt >= delayedSelection.selectedWallAt + 650,
      `划词翻译请求发起过早：${JSON.stringify({ selectedWallAt: delayedSelection.selectedWallAt, delayedRequestAt })}`);
    result.cases.push({
      id: 'delay.direct-no-early-ui-or-request',
      status: 'passed',
      configuredDelay: 800,
      observedDelay: delayedVisible.at - delayedSelection.selectedWallAt,
      requestDelay: delayedRequestAt - delayedSelection.selectedWallAt,
      duringDelay,
      transitions: delayedTransitions,
    });

    await closeSelectionUi(page);
    await resetFixture(page);
    const cancelledRequestsBefore = translationRequestCount;
    await clearSelectionAfter(page, '#target', 120);
    await page.waitForTimeout(900);
    const cancelledUi = await readSelectionUi(page);
    assert(!cancelledUi.indicator && !cancelledUi.tooltip, `取消选区后延迟 UI 仍然出现：${JSON.stringify(cancelledUi)}`);
    assert(translationRequestCount === cancelledRequestsBefore,
      `取消选区后仍发起翻译请求：${cancelledRequestsBefore} -> ${translationRequestCount}`);
    result.cases.push({ id: 'delay.cancelled-selection-no-request', status: 'passed', ui: cancelledUi });

    await closeSelectionUi(page);
    await resetFixture(page);
    const changedRequestsBefore = translationRequestCount;
    const replacementSelection = await replaceSelectionAfter(page, '#target', '#neighbor', 120);
    await page.waitForTimeout(250);
    const duringReplacementDelay = await readSelectionUi(page);
    assert(!duringReplacementDelay.indicator && !duringReplacementDelay.tooltip, '改选后沿用了旧选区的延迟计时器');
    assert(translationRequestCount === changedRequestsBefore, '改选等待期间提前发起了翻译请求');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true, resultPrefix: '测试译文：' }, '改选后只显示新选区翻译');
    const replacementUi = await readSelectionUi(page);
    assert(replacementUi.originalText === replacementSelection.text,
      `改选后显示了旧文本：${JSON.stringify({ expected: replacementSelection.text, actual: replacementUi.originalText })}`);
    assert(translationRequestCount === changedRequestsBefore + 1,
      `改选后请求数异常：${changedRequestsBefore} -> ${translationRequestCount}`);
    result.cases.push({ id: 'delay.changed-selection-invalidates-old-timer', status: 'passed', ui: replacementUi });

    await closeSelectionUi(page);
    await setSelectionDelay(selectionUi, 1000);
    await setSelectionTrigger(selectionUi, 'Ctrl');
    await resetFixture(page);
    const shortcutDelayRequestsBefore = translationRequestCount;
    await selectTextWithDomRange(page, '#target');
    await triggerShortcut(page, 'Ctrl', 250);
    const duringShortcutDelay = await readSelectionUi(page);
    assert(!duringShortcutDelay.indicator && !duringShortcutDelay.tooltip, '快捷键在剩余延迟结束前提前显示了翻译框');
    assert(translationRequestCount === shortcutDelayRequestsBefore, '快捷键等待期间提前发起了翻译请求');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '快捷键等待剩余延迟后显示翻译框');
    result.cases.push({ id: 'delay.shortcut-waits-remaining-time', status: 'passed', duringDelay: duringShortcutDelay });

    // 设置页在线修改延迟后，当前页面按原选区时间重算剩余时长，无需刷新。
    await closeSelectionUi(page);
    await setSelectionTrigger(selectionUi, '直接弹出');
    await resetFixture(page);
    await selectTextWithDomRange(page, '#target');
    await page.waitForTimeout(150);
    assert(!(await readSelectionUi(page)).tooltip, '在线修改延迟前翻译框已提前显示');
    await setSelectionDelay(selectionUi, 200, 100);
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '在线缩短延迟后显示当前选区');
    result.cases.push({ id: 'delay.live-settings-reschedule', status: 'passed', configuredDelay: 200 });

    await closeSelectionUi(page);
    await setSelectionDelay(selectionUi, 0);
    await patchStoredConfig(popup, { to: 'fr' });
    await page.waitForTimeout(700);
    await setSelectionTrigger(selectionUi, '直接弹出');
    await resetFixture(page);
    translationResponseDelayMs = 500;
    const sameTextRequestsBefore = translationRequestCount;
    await selectTextWithDomRange(page, '#target');
    await waitForSelectionUi(page, { tooltip: true, indicator: false }, '0ms 配置立即显示空白加载框');
    await page.waitForTimeout(80);
    const sameTextPendingUi = await readSelectionUi(page);
    assert(sameTextPendingUi.resultText === '', `重新选择相同文本时先显示了旧译文：${sameTextPendingUi.resultText}`);
    await waitForSelectionUi(page, { tooltip: true, translation: true, resultPrefix: '测试译文：' }, '相同文本重新请求完成');
    translationResponseDelayMs = 0;
    assert(translationRequestCount === sameTextRequestsBefore + 1,
      `相同文本重选请求数异常：${sameTextRequestsBefore} -> ${translationRequestCount}`);
    result.cases.push({ id: 'delay.zero-and-same-text-no-stale-result', status: 'passed', pendingUi: sameTextPendingUi });

    await closeSelectionUi(page);
    await patchStoredConfig(popup, { to: 'zh-Hans' });
    await page.waitForTimeout(700);
    await setSelectionDelay(selectionUi, 300);

    // 原生三击：普通段落和 JetBrains 评论形状都应显示入口。
    // JetBrains 形状的 Range 会夹带一个 display:none 的 button，但可见选区只有正文。
    await closeSelectionUi(page);
    await setSelectionDelay(selectionUi, 0);
    const tripleClickPopupState = await setSelectionTrigger(selectionUi, '显示图标');

    await resetFixture(page);
    const standardTripleClick = await tripleClickTarget(page);
    assert(standardTripleClick.mouseDown?.isTrusted === true
      && standardTripleClick.mouseDown.detail === 3
      && standardTripleClick.mouseDown.button === 0,
    `普通段落没有收到可信的左键三击：${JSON.stringify(standardTripleClick.mouseDown)}`);
    assert(standardTripleClick.text === TARGET_TEXT && !standardTripleClick.fragment.button,
      `普通段落三击 Range 形状异常：${JSON.stringify(standardTripleClick)}`);
    await waitForSelectionUi(page, {
      indicator: true,
      tooltip: false,
      indicatorClass: 'fr-selection-indicator fr-selection-indicator--icon',
    }, '普通段落三击显示入口');
    const standardTripleClickUi = await readSelectionUi(page);
    result.cases.push({
      id: 'selection.triple-click-standard-control',
      status: 'passed',
      selection: standardTripleClick,
      ui: standardTripleClickUi,
    });

    await closeSelectionUi(page);
    await resetTripleClickFixture(page, false);
    const hiddenButtonTripleClick = await tripleClickTarget(page);
    assert(hiddenButtonTripleClick.mouseDown?.isTrusted === true
      && hiddenButtonTripleClick.mouseDown.detail === 3
      && hiddenButtonTripleClick.mouseDown.button === 0,
    `JetBrains 形状选区没有收到可信的左键三击：${JSON.stringify(hiddenButtonTripleClick.mouseDown)}`);
    assert(hiddenButtonTripleClick.text === TARGET_TEXT
      && hiddenButtonTripleClick.start.id === 'target'
      && hiddenButtonTripleClick.start.offset === 0
      && hiddenButtonTripleClick.end.id === 'selection-triple-click-footer'
      && hiddenButtonTripleClick.end.offset === 0,
    `JetBrains 形状的三击 Range 边界不符合前置条件：${JSON.stringify(hiddenButtonTripleClick)}`);
    assert(hiddenButtonTripleClick.fragment.button?.tagName === 'BUTTON'
      && hiddenButtonTripleClick.fragment.button.text === 'more'
      && hiddenButtonTripleClick.fragment.footer,
    `JetBrains 形状的 Range clone 没有夹带隐藏按钮和 footer 边界：${JSON.stringify(hiddenButtonTripleClick.fragment)}`);
    assert(hiddenButtonTripleClick.sourceButton?.display === 'none'
      && hiddenButtonTripleClick.sourceButton.rects.length === 0
      && hiddenButtonTripleClick.sourceButton.intersectsRange
      && !hiddenButtonTripleClick.sourceButton.overlapsSelectionRects
      && !hiddenButtonTripleClick.selectedTextIncludesButtonText,
    `JetBrains 形状的夹带按钮不是无可见几何的结构噪声：${JSON.stringify(hiddenButtonTripleClick.sourceButton)}`);
    await waitForSelectionUi(page, {
      indicator: true,
      tooltip: false,
      indicatorClass: 'fr-selection-indicator fr-selection-indicator--icon',
    }, 'JetBrains 形状三击忽略隐藏按钮后显示入口');
    const hiddenButtonTripleClickUi = await readSelectionUi(page);
    const hiddenButtonTripleClickScreenshot = path.join(args.artifactsDir, 'selection-triple-click-hidden-button.png');
    await page.screenshot({ path: hiddenButtonTripleClickScreenshot });
    result.screenshots.push(hiddenButtonTripleClickScreenshot);
    result.cases.push({
      id: 'selection.triple-click-hidden-button-regression',
      status: 'passed',
      popupState: tripleClickPopupState,
      selection: hiddenButtonTripleClick,
      ui: hiddenButtonTripleClickUi,
    });

    // 可见交互控件仍是安全边界：同样的 DOM 顺序改为可见 button 后必须拒绝。
    await closeSelectionUi(page);
    await resetTripleClickFixture(page, true);
    const visibleButtonTripleClick = await tripleClickTarget(page);
    assert(visibleButtonTripleClick.mouseDown?.isTrusted === true
      && visibleButtonTripleClick.mouseDown.detail === 3
      && visibleButtonTripleClick.mouseDown.button === 0
      && visibleButtonTripleClick.text === TARGET_TEXT
      && visibleButtonTripleClick.fragment.button?.tagName === 'BUTTON'
      && visibleButtonTripleClick.sourceButton?.display !== 'none'
      && visibleButtonTripleClick.sourceButton?.rects.length > 0
      && visibleButtonTripleClick.sourceButton?.intersectsRange,
    `可见 button 对照没有产生预期 Range：${JSON.stringify(visibleButtonTripleClick)}`);
    await page.waitForTimeout(500);
    const visibleButtonTripleClickUi = await readSelectionUi(page);
    assert(!visibleButtonTripleClickUi.indicator && !visibleButtonTripleClickUi.tooltip,
      `三击 Range 包含可见 button 时仍显示了划词入口：${JSON.stringify(visibleButtonTripleClickUi)}`);
    result.cases.push({
      id: 'selection.triple-click-visible-button-rejected',
      status: 'passed',
      selection: visibleButtonTripleClick,
      ui: visibleButtonTripleClickUi,
    });

    await closeSelectionUi(page);
    await setSelectionDelay(selectionUi, 300);

    // 视觉触发方式：设置页修改后不刷新网页，真实鼠标划词仍应反映新模式。
    for (const mode of [
      { label: '显示图标', className: 'fr-selection-indicator fr-selection-indicator--icon' },
      { label: '显示小点', className: 'fr-selection-indicator fr-selection-indicator--dot' },
    ]) {
      await closeSelectionUi(page);
      const popupState = await setSelectionTrigger(selectionUi, mode.label);
      await resetFixture(page);
      const selection = await selectTarget(page);
      await waitForSelectionUi(page, { indicator: true, tooltip: false, indicatorClass: mode.className }, `${mode.label} 显示入口`);
      const beforeClick = await readSelectionUi(page);
      assert(beforeClick.selectionText === selection.text, `${mode.label} 选区文本不一致`);
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, { tooltip: true, translation: true, resultPrefix: '测试译文：' }, `${mode.label} 点击后显示翻译`);
      const afterClick = await readSelectionUi(page);
      assert(afterClick.targetText === TARGET_TEXT, `${mode.label} 点击后改写了页面正文`);
      const screenshot = path.join(args.artifactsDir, `selection-${mode.label === '显示图标' ? 'icon' : 'dot'}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
      result.cases.push({ id: `visual.${mode.label}`, status: 'passed', popupState, selection, beforeClick, afterClick });
    }

    await closeSelectionUi(page);
    const directPopupState = await setSelectionTrigger(selectionUi, '直接弹出');
    await resetFixture(page);
    const directSelection = await selectTarget(page);
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true, resultPrefix: '测试译文：' }, '直接弹出翻译框');
    const directUi = await readSelectionUi(page);
    assert(directUi.selectionText === directSelection.text && !directUi.indicator && directUi.targetText === TARGET_TEXT, '直接弹出改变了入口或页面正文');
    assert(!directUi.tooltipText.includes('FluentRead')
      && directUi.brandIcon.present && /^chrome-extension:\/\/[^/]+\/icon\/128\.png$/u.test(directUi.brandIcon.src)
      && !directUi.navigation.standaloneHeader && !directUi.navigation.targetLanguageControl
      && directUi.navigation.present && directUi.navigation.close && directUi.navigation.share
      && directUi.copyButtons.source
      && directUi.copyButtons.translation,
    `翻译卡品牌图标、紧凑导航操作或独立复制入口异常：${JSON.stringify(directUi)}`);
    const directScreenshot = path.join(args.artifactsDir, 'selection-direct.png');
    await page.screenshot({ path: directScreenshot });
    result.screenshots.push(directScreenshot);
    result.cases.push({ id: 'visual.直接弹出', status: 'passed', popupState: directPopupState, selection: directSelection, ui: directUi });

    await clickSelectionCopyButton(page, 'source');
    const sourceCopyFeedback = await waitForCopyFeedback(page, '已复制原文');
    const sourceCopiedUi = await readSelectionUi(page);
    assert(sourceCopiedUi.copyButtons.sourceLabel === '已复制', `原文复制按钮没有进入已复制状态：${JSON.stringify(sourceCopiedUi)}`);
    await clickSelectionCopyButton(page, 'translation');
    const translationCopyFeedback = await waitForCopyFeedback(page, '已复制译文');
    const translationCopiedUi = await readSelectionUi(page);
    assert(translationCopiedUi.copyButtons.translationLabel === '已复制', `译文复制按钮没有进入已复制状态：${JSON.stringify(translationCopiedUi)}`);
    result.cases.push({
      id: 'copy.source-and-translation-actions',
      status: 'passed',
      sourceCopyFeedback,
      translationCopyFeedback,
      sourceCopiedUi,
      translationCopiedUi,
    });

    // 显示方式：双语和仅译文应分别渲染对应内容。
    await closeSelectionUi(page);
    await setSelectionMode(selectionUi, '仅译文');
    await setSelectionTrigger(selectionUi, '直接弹出');
    await resetFixture(page);
    await selectTarget(page);
    await waitForSelectionUi(page, { tooltip: true, original: false, translation: true, resultPrefix: '测试译文：' }, '仅译文模式');
    const translationOnlyUi = await readSelectionUi(page);
    assert(translationOnlyUi.targetText === TARGET_TEXT && translationOnlyUi.translation && !translationOnlyUi.original && translationOnlyUi.resultText.startsWith('测试译文：'), '仅译文模式渲染不完整或改写了页面正文');
    result.cases.push({ id: 'display.translation-only', status: 'passed', ui: translationOnlyUi });

    await closeSelectionUi(page);
    await setSelectionMode(selectionUi, '双语显示');
    await resetFixture(page);
    await selectTarget(page);
    await waitForSelectionUi(page, { tooltip: true, original: true, translation: true, resultPrefix: '测试译文：' }, '双语显示模式');
    const bilingualUi = await readSelectionUi(page);
    assert(bilingualUi.targetText === TARGET_TEXT && bilingualUi.original && bilingualUi.translation && bilingualUi.resultText.startsWith('测试译文：'), '双语模式渲染不完整或改写了页面正文');
    result.cases.push({ id: 'display.bilingual', status: 'passed', ui: bilingualUi });

    // 开关停用时保留两种显示偏好，重开恢复原偏好；网页 UI 同步卸载并重新挂载。
    for (const [label, expectedMode] of Object.entries(SELECTION_MODE_VALUES)) {
      await closeSelectionUi(page);
      await setSelectionMode(selectionUi, label);
      const disabled = await setSelectionEnabled(selectionUi, false);
      const stored = await readStoredConfig(popup);
      assert(stored.selectionTranslatorModeBeforeDisable === expectedMode
        && disabled.popup.modes.find(mode => mode.label === label)?.pressed === 'true',
        `关闭划词翻译没有保留 ${label} 偏好：${JSON.stringify({stored, disabled})}`);
      await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'detached', timeout: 10000 });
      result.cases.push({ id: expectedMode === 'bilingual' ? 'selection.disabled' : `selection.disabled.${expectedMode}`, status: 'passed', expectedMode });
      const enabled = await setSelectionEnabled(selectionUi, true);
      assert(enabled.mode === expectedMode && enabled.popup.modes.find(mode => mode.label === label)?.pressed === 'true',
        `重新启用划词翻译没有恢复 ${label} 偏好：${JSON.stringify(enabled)}`);
      await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'attached', timeout: 10000 });
      result.cases.push({ id: expectedMode === 'bilingual' ? 'selection.re-enabled' : `selection.re-enabled.${expectedMode}`, status: 'passed', expectedMode });
    }
    await setSelectionMode(selectionUi, '双语显示');

    // 预设快捷键：选区旁不显示图标/小点，按对应键后直接打开翻译框。
    for (const label of ['Ctrl', 'Alt / Option', 'Shift']) {
      await closeSelectionUi(page);
      const popupState = await setSelectionTrigger(selectionUi, label);
      await resetFixture(page);
      await selectTarget(page);
      await page.waitForTimeout(350);
      const beforeShortcut = await readSelectionUi(page);
      assert(!beforeShortcut.indicator && !beforeShortcut.tooltip, `${label} 模式仍显示了图标或翻译框`);
      await triggerShortcut(page, label);
      await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, `${label} 快捷键触发翻译`);
      const afterShortcut = await readSelectionUi(page);
      assert(afterShortcut.targetText === TARGET_TEXT, `${label} 快捷键改写了页面正文`);
      const screenshot = path.join(args.artifactsDir, `selection-${label === 'Ctrl' ? 'control' : label === 'Alt / Option' ? 'alt' : 'shift'}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
      result.cases.push({ id: `shortcut.${label}`, status: 'passed', popupState, beforeShortcut, afterShortcut });
    }

    // 冲突优先级与稳定性：Ctrl 同时配置为划词和鼠标悬浮快捷键时，
    // 有有效选区必须只打开划词框；没有选区时仍回退到悬浮翻译。
    await closeSelectionUi(page);
    const conflictPopupState = await setSelectionTrigger(selectionUi, 'Ctrl');
    await patchStoredConfig(popup, { hotkey: 'Control', customHotkey: '', floatingBallHotkey: 'Control' });
    await page.waitForTimeout(700);
    await resetFixture(page);
    const conflictSelection = await selectTarget(page);
    await startSelectionUiTracking(page);
    await triggerShortcut(page, 'Ctrl');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '快捷键冲突时优先打开划词翻译');
    const conflictUi = await readSelectionUi(page);
    const conflictHoverCount = await page.locator('#target .fluent-read-bilingual-content').count();
    assert(conflictHoverCount === 0, `快捷键冲突时同时触发了鼠标悬浮翻译：${conflictHoverCount}`);
    const conflictPageTranslationCount = await page.locator('.fluent-read-bilingual-content').count();
    assert(conflictPageTranslationCount === 0, `快捷键冲突时同时触发了全文翻译：${conflictPageTranslationCount}`);
    const requestsAfterOpen = translationRequestCount;
    const configBeforeRefresh = await readStoredConfig(popup);
    await patchStoredConfig(popup, { contextMenuEnabled: configBeforeRefresh.contextMenuEnabled === false });
    await page.waitForTimeout(700);
    const configRefreshTransitions = await stopSelectionUiTracking(page);
    const firstVisibleTransition = configRefreshTransitions.findIndex(item => item.tooltip);
    assert(firstVisibleTransition >= 0 && configRefreshTransitions.slice(firstVisibleTransition).every(item => item.tooltip), `无关配置刷新关闭了划词翻译框：${JSON.stringify(configRefreshTransitions)}`);
    assert(translationRequestCount === requestsAfterOpen, `无关配置刷新重复发起翻译：${requestsAfterOpen} -> ${translationRequestCount}`);
    const stableTransitions = await exerciseTransientSelectionLoss(page);
    const stableUi = await readSelectionUi(page);
    assert(stableUi.tooltip && stableUi.selectionText === conflictSelection.text, '瞬时选区变化后划词翻译框或原选区丢失');
    await clearPageSelection(page);
    await page.waitForTimeout(350);
    const clearedUi = await readSelectionUi(page);
    assert(!clearedUi.tooltip && !clearedUi.indicator, '选区永久清除后划词翻译框仍未关闭');
    result.cases.push({
      id: 'conflict.selection-priority-and-stability',
      status: 'passed',
      popupState: conflictPopupState,
      selection: conflictSelection,
      beforeTransientLoss: conflictUi,
      configRefreshTransitions,
      requestsAfterOpen,
      transitions: stableTransitions,
      afterClear: clearedUi,
    });

    await closeSelectionUi(page);
    await resetFixture(page);
    await clearPageSelection(page);
    const hoverTarget = page.locator('#target');
    const hoverBox = await hoverTarget.boundingBox();
    assert(hoverBox, '无选区冲突测试缺少悬浮目标几何位置');
    await page.mouse.move(hoverBox.x + Math.min(80, hoverBox.width / 2), hoverBox.y + hoverBox.height / 2);
    await page.keyboard.press('Control');
    const hoverFallback = await waitForHoverTranslation(page);
    assert(!hoverFallback.selectionTooltip && hoverFallback.count === 1, `无选区时没有回退到鼠标悬浮翻译：${JSON.stringify(hoverFallback)}`);
    assert(await page.locator('#neighbor .fluent-read-bilingual-content').count() === 0, '无选区悬浮回退时同时触发了全文翻译');
    result.cases.push({ id: 'conflict.hover-fallback-without-selection', status: 'passed', ui: hoverFallback });
    await triggerShortcut(page, 'Ctrl');
    await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length === 0, undefined, { timeout: 10000 });
    result.cases.push({ id: 'conflict.Control.hover-restore', status: 'passed', translatedCounts: [1, 0] });

    // 使用设置页支持的 F9：划词与全文共享、悬浮不共享时，在 keyup 回退全文翻译。
    await closeSelectionUi(page);
    await setSelectionTrigger(selectionUi, '自定义');
    await patchStoredConfig(popup, { hotkey: 'none', customHotkey: '', floatingBallHotkey: 'F9', customFloatingBallHotkey: '' });
    await page.waitForTimeout(700);
    await resetFixture(page);
    await clearPageSelection(page);
    await activateInputPage(page);
    await page.keyboard.press('F9');
    try {
      await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length >= 2, undefined, { timeout: 10000 });
    } catch (error) {
      const saved = await readStoredConfig(popup);
      result.fullPageFallbackDiagnostic = {
        config: Object.fromEntries(['on', 'hotkey', 'customHotkey', 'floatingBallHotkey', 'selectionTranslatorTrigger', 'selectionTranslatorMode', 'disableSelectionTranslator', 'from', 'to', 'service'].map(key => [key, saved[key]])),
        batchSizes: translationRequestBatchSizes,
        ui: await readSelectionUi(page),
        page: await page.evaluate(() => ({
          translationCount: document.querySelectorAll('.fluent-read-bilingual-content').length,
          fixture: document.querySelector('#selection-test-fixture')?.outerHTML,
          selectedText: window.getSelection()?.toString(),
        })),
      };
      throw error;
    }
    const fullPageDomState = await page.evaluate(() => ({
      translatedCount: document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length,
    }));
    const fullPageSelectionState = await readSelectionUi(page);
    const fullPageFallback = { ...fullPageDomState, selectionTooltip: fullPageSelectionState.tooltip };
    assert(!fullPageFallback.selectionTooltip, `无选区全文回退时误开划词翻译：${JSON.stringify(fullPageFallback)}`);
    result.cases.push({ id: 'conflict.full-page-fallback-without-selection-or-hover', status: 'passed', ui: fullPageFallback });
    await page.keyboard.press('F9');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0, undefined, { timeout: 10000 });

    const requestsBeforeExtraKey = translationRequestCount;
    await page.keyboard.down('F9');
    await page.keyboard.down('x');
    await page.keyboard.up('x');
    await page.waitForTimeout(450);
    assert(await page.locator('.fluent-read-bilingual-content').count() === 0,
      '仍按住 F9 时，无关 X 的释放消费了全文回退');
    await page.keyboard.up('F9');
    await page.waitForTimeout(450);
    assert(await page.locator('.fluent-read-bilingual-content').count() === 0
      && translationRequestCount === requestsBeforeExtraKey, '额外键已取消的 F9 手势仍启动全文翻译');
    result.cases.push({ id: 'conflict.full-page-extra-key-cancels-pending', status: 'passed' });

    await page.keyboard.down('F9');
    await patchStoredConfig(popup, { floatingBallHotkey: 'none' });
    await page.waitForTimeout(700);
    await page.keyboard.up('F9');
    await page.waitForTimeout(450);
    assert(await page.locator('.fluent-read-bilingual-content').count() === 0,
      '已禁用的全文快捷键仍消费旧 F9 手势');
    result.cases.push({ id: 'conflict.full-page-disabled-config-cancels-pending', status: 'passed' });
    await patchStoredConfig(popup, { floatingBallHotkey: 'F9' });
    await page.waitForTimeout(700);

    await page.keyboard.down('F9');
    await page.evaluate(() => history.pushState({}, '', '/?selection-gesture-route'));
    await page.waitForTimeout(700);
    await page.keyboard.up('F9');
    await page.waitForTimeout(450);
    assert(await page.locator('.fluent-read-bilingual-content').count() === 0,
      '同文档路由切换后仍消费旧页面的 F9 手势');
    result.cases.push({ id: 'conflict.full-page-route-change-cancels-pending', status: 'passed' });


    // 已有效的录制草稿只归当前快捷键所有；其它上下文的完整回写不丢失未确认的 F10。
    await activateInputPage(selectionUi.options);
    await selectionUi.options.getByRole('button', { name: '编辑划词翻译快捷键', exact: true }).click();
    let shortcutDraftDialog = selectionUi.options.locator('.custom-hotkey-dialog:visible').last();
    await shortcutDraftDialog.waitFor({ state: 'visible', timeout: 10000 });
    await shortcutDraftDialog.locator('.hotkey-input-field').click();
    await selectionUi.options.keyboard.press('F10');
    await shortcutDraftDialog.getByRole('button', { name: '当前快捷键为 F10', exact: true })
      .waitFor({ state: 'visible', timeout: 10000 });
    assert(!await shortcutDraftDialog.getByRole('button', { name: '确认', exact: true }).isDisabled(),
      '真实键盘录制的 F10 尚未成为可确认草稿');
    assert((await readStoredConfig(popup)).customSelectionTranslatorHotkey === 'F9', '录制 F10 提前提交了配置');
    await patchStoredConfig(popup, { hotkey: 'Alt' });
    await selectionUi.options.waitForTimeout(700);
    assert(await shortcutDraftDialog.isVisible(), '无关悬浮快捷键的外部回写关闭了划词录制草稿');
    assert((await shortcutDraftDialog.locator('.hotkey-display kbd').textContent())?.trim() === 'F10',
      '无关快捷键的外部回写丢失了本地未确认的 F10');
    const retainedDraftConfig = await readStoredConfig(popup);
    assert(retainedDraftConfig.customSelectionTranslatorHotkey === 'F9'
      && retainedDraftConfig.selectionTranslatorTrigger === 'custom', '未确认的 F10 提前覆盖了已保存的 F9');
    await shortcutDraftDialog.getByRole('button', { name: '取消', exact: true }).click();
    await shortcutDraftDialog.waitFor({ state: 'hidden', timeout: 10000 });
    assert((await readStoredConfig(popup)).customSelectionTranslatorHotkey === 'F9', '取消录制改写了已保存的 F9');
    result.cases.push({ id: 'shortcut.custom-draft-survives-unrelated-external-hotkey', status: 'passed',
      recordedHotkey: 'F10', persistedHotkey: 'F9' });

    await selectionUi.options.getByRole('button', { name: '编辑划词翻译快捷键', exact: true }).click();
    shortcutDraftDialog = selectionUi.options.locator('.custom-hotkey-dialog:visible').last();
    await shortcutDraftDialog.waitFor({ state: 'visible', timeout: 10000 });
    await shortcutDraftDialog.getByRole('button', { name: 'F10', exact: true }).click();
    await patchStoredConfig(popup, { customSelectionTranslatorHotkey: 'F8' });
    await shortcutDraftDialog.waitFor({ state: 'hidden', timeout: 10000 });
    const replacedDraftConfig = await readStoredConfig(popup);
    assert(replacedDraftConfig.customSelectionTranslatorHotkey === 'F8'
      && replacedDraftConfig.selectionTranslatorTrigger === 'custom', '自身快捷键外部变化没有保留已保存的 F8');
    result.cases.push({ id: 'shortcut.custom-draft-cancelled-by-own-external-hotkey', status: 'passed', persistedHotkey: 'F8' });
    await patchStoredConfig(popup, { hotkey: 'none', customSelectionTranslatorHotkey: 'F9' });
    await selectionUi.options.waitForTimeout(700);

    await closeSelectionUi(page);
    const customPopupState = await setSelectionTrigger(selectionUi, '自定义');
    await resetFixture(page);
    await selectTarget(page);
    await page.waitForTimeout(350);
    const beforeCustom = await readSelectionUi(page);
    assert(!beforeCustom.indicator && !beforeCustom.tooltip, '自定义快捷键模式仍显示了图标或翻译框');
    await triggerShortcut(page, '自定义');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '自定义快捷键触发翻译');
    const afterCustom = await readSelectionUi(page);
    assert(afterCustom.targetText === TARGET_TEXT, '自定义快捷键改写了页面正文');
    const customScreenshot = path.join(args.artifactsDir, 'selection-custom.png');
    await page.screenshot({ path: customScreenshot });
    result.screenshots.push(customScreenshot);
    result.cases.push({ id: 'shortcut.custom', status: 'passed', popupState: customPopupState, beforeShortcut: beforeCustom, afterShortcut: afterCustom });

    await closeSelectionUi(page);
    await patchStoredConfig(popup, {
      hotkey: 'custom',
      customHotkey: 'F9',
      floatingBallHotkey: 'custom',
      customFloatingBallHotkey: 'F9',
    });
    await page.waitForTimeout(700);
    await resetFixture(page);
    await activateInputPage(page);
    await page.keyboard.down('F9');
    await page.waitForTimeout(600);
    const heldCustomSelection = await selectTarget(page, true);
    await page.keyboard.up('F9');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '长按自定义快捷键后拖选仍触发划词翻译');
    const heldCustomUi = await readSelectionUi(page);
    assert(await page.locator('#target .fluent-read-bilingual-content').count() === 0, '长按自定义键拖选时同时触发了悬浮翻译');
    assert(await page.locator('#neighbor .fluent-read-bilingual-content').count() === 0, '长按自定义键拖选时全文翻译抢先触发');
    result.cases.push({
      id: 'shortcut.custom-held-before-selection',
      status: 'passed',
      selection: heldCustomSelection,
      ui: heldCustomUi,
    });

    for (const conflictCase of [
      { label: 'Alt / Option', hoverHotkey: 'Alt', customHotkey: '' },
      { label: 'Shift', hoverHotkey: 'Shift', customHotkey: '' },
      { label: '自定义', hoverHotkey: 'custom', customHotkey: 'F9' },
    ]) {
      await closeSelectionUi(page);
      const popupState = await setSelectionTrigger(selectionUi, conflictCase.label);
      await patchStoredConfig(popup, { hotkey: conflictCase.hoverHotkey, customHotkey: conflictCase.customHotkey });
      await page.waitForTimeout(700);
      await resetFixture(page);
      // DOM 重建会触发译文重挂载恢复；先证明上一用例已恢复，避免把旧译文误报为本次快捷键冲突。
      const beforeSelectionHoverCount = await page.locator('#target .fluent-read-bilingual-content').count();
      assert(beforeSelectionHoverCount === 0, `${conflictCase.label} 冲突测试开始前已存在上一用例译文：${beforeSelectionHoverCount}`);
      await selectTarget(page);
      const beforeShortcutHoverCount = await page.locator('#target .fluent-read-bilingual-content').count();
      assert(beforeShortcutHoverCount === 0, `${conflictCase.label} 按快捷键前已出现悬浮译文：${beforeShortcutHoverCount}`);
      const requestsBeforeShortcut = translationRequestCount;
      await triggerShortcut(page, conflictCase.label);
      await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, `${conflictCase.label} 冲突时优先划词翻译`);
      const priorityUi = await readSelectionUi(page);
      const hoverCount = await page.locator('#target .fluent-read-bilingual-content').count();
      assert(hoverCount === 0, `${conflictCase.label} 冲突时同时触发悬浮翻译：${hoverCount}`);
      result.cases.push({ id: `conflict.${conflictCase.label}.selection-priority`, status: 'passed', popupState, beforeSelectionHoverCount, beforeShortcutHoverCount, hoverCount, requestsBeforeShortcut, requestsAfterShortcut: translationRequestCount, ui: priorityUi });

      await closeSelectionUi(page);
      await resetFixture(page);
      await clearPageSelection(page);
      const target = page.locator('#target');
      const box = await target.boundingBox();
      assert(box, `${conflictCase.label} 无选区测试缺少目标几何位置`);
      await page.mouse.move(box.x + Math.min(80, box.width / 2), box.y + box.height / 2);
      await triggerShortcut(page, conflictCase.label);
      const hoverUi = await waitForHoverTranslation(page);
      assert(!hoverUi.selectionTooltip && hoverUi.count === 1, `${conflictCase.label} 无选区时未回退悬浮翻译：${JSON.stringify(hoverUi)}`);
      result.cases.push({ id: `conflict.${conflictCase.label}.hover-fallback`, status: 'passed', ui: hoverUi });

      // 用产品的真实恢复手势清理翻译会话，不能仅 remove() DOM 后假定状态已清空。
      await triggerShortcut(page, conflictCase.label);
      await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length === 0, undefined, { timeout: 10000 });
      const restoredText = await page.locator('#target').textContent();
      assert(restoredText === TARGET_TEXT, `${conflictCase.label} 悬浮恢复后正文发生变化：${restoredText}`);
      result.cases.push({ id: `conflict.${conflictCase.label}.hover-restore`, status: 'passed', translatedCounts: [1, 0], restoredText });

      // Window 上的悬浮释放事件仍须到达 Document，清除划词的按住状态。
      // 已松开快捷键后的普通拖选只能等待下一次明确触发，不得自行打开卡片。
      const requestsAfterHoverRelease = translationRequestCount;
      const ordinarySelection = await selectTarget(page);
      await page.waitForTimeout(700);
      const ordinarySelectionUi = await readSelectionUi(page);
      assert(!ordinarySelectionUi.tooltip && !ordinarySelectionUi.indicator,
        `${conflictCase.label} 松键后的普通拖选误用了旧快捷键：${JSON.stringify(ordinarySelectionUi)}`);
      assert(translationRequestCount === requestsAfterHoverRelease,
        `${conflictCase.label} 松键后的普通拖选自动发起翻译：${requestsAfterHoverRelease} -> ${translationRequestCount}`);
      assert(await page.locator('.fluent-read-bilingual-content').count() === 0,
        `${conflictCase.label} 松键后的普通拖选误触发页面翻译`);
      result.cases.push({ id: `conflict.${conflictCase.label}.released-hover-does-not-own-next-selection`,
        status: 'passed', selection: ordinarySelection, ui: ordinarySelectionUi });
      await triggerShortcut(page, conflictCase.label);
      await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true },
        `${conflictCase.label} 松键后新的快捷键仍能打开划词翻译`);
      const freshShortcutUi = await readSelectionUi(page);
      assert(await page.locator('.fluent-read-bilingual-content').count() === 0,
        `${conflictCase.label} 松键后新的划词快捷键同时触发页面翻译`);
      result.cases.push({ id: `conflict.${conflictCase.label}.new-shortcut-after-release`, status: 'passed', ui: freshShortcutUi });
    }

    result.finalConfig = await readStoredConfig(popup);
    result.ok = result.cases.every(item => item.status === 'passed') && result.consoleErrors.length === 0;
    if (!result.ok) throw new Error(`划词浏览器回归未通过：${JSON.stringify({consoleErrors: result.consoleErrors})}`);
    fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    primaryError = error;
    result.ok = false;
    result.error = error.stack || error.message || String(error);
    if ((args.clickSelectionOnly || args.documentShellOnly) && context) {
      for (const [index, failedPage] of context.pages().entries()) {
        try {
          const screenshot = path.join(args.artifactsDir, `${args.documentShellOnly ? 'document-shell' : 'click-selection'}-failure-${index}.png`);
          await failedPage.screenshot({path: screenshot, timeout: 5000, ...(args.documentShellOnly ? {caret: 'initial'} : {})});
          result.screenshots.push(screenshot);
        } catch (captureError) {
          (result.captureGaps ||= []).push({surface: `page-${index}`, error: String(captureError.message || captureError)});
        }
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    for (const tracker of ownedSelectionUiTrackers) {tracker.active = false; clearInterval(tracker.timer);}
    ownedSelectionUiTrackers.clear();
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try {await release();} catch (error) {
        cleanupErrors.push(error);
        (result.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        result.ok = false;
        if (resource === 'profile') result.retainedProfile = profileDir;
      }
    };
    if (runtimeDiagnostics) {
      await cleanup('runtime diagnostics', async () => {
        await runtimeDiagnostics.flush();
        runtimeDiagnostics.write(args.artifactsDir, result);
        await runtimeDiagnostics.stop();
      });
    }
    let browserClosed = !browserStartAttempted;
    await cleanup('browser', async () => {
      if (closeBrowser) {await closeBrowser(); browserClosed = true;}
    });
    await cleanup('translation server', () => new Promise((resolve, reject) => {
      if (!translationServer.listening) {resolve(); return;}
      translationServer.close(error => error ? reject(error) : resolve());
      translationServer.closeAllConnections();
    }));
    await cleanup('profile', () => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else result.retainedProfile = profileDir;
    });
    await cleanup('report', () => {
      fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    });
    if (result.retainedProfile) process.stderr.write(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}\n`);
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length) process.exitCode = 1;
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = {readStoredConfig, patchStoredConfig, sendExtensionMessage, waitForWorker, selectTextWithDomRange, getSelectionUiTree, findCdpNode, cdpAttribute, hasCdpClass, cdpText, clickSelectionIndicator, closeSelectionUi};
