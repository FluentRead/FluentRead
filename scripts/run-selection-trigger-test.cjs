#!/usr/bin/env node

// 使用临时 Edge profile 验证划词翻译的触发矩阵；--context-menu-only 只运行右键入口专项。
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
    directionOnly: argv.includes('--direction-only'),
    geometryOnly: argv.includes('--geometry-only'),
    zoomOnly: argv.includes('--zoom-only'),
    scrollOnly: argv.includes('--scroll-only'),
    inlineCodeOnly: argv.includes('--inline-code-only'),
  };
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
  const chineseTarget = findCdpNode(host, node => /^zh-/.test(cdpAttribute(node, 'data-target-language') || ''));
  const englishTarget = findCdpNode(host, node => cdpAttribute(node, 'data-target-language') === 'en');
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
    direction: {
      chinese: cdpAttribute(chineseTarget, 'aria-pressed') === 'true',
      english: cdpAttribute(englishTarget, 'aria-pressed') === 'true',
      chineseDisabled: cdpHasAttribute(chineseTarget, 'disabled'),
      englishDisabled: cdpHasAttribute(englishTarget, 'disabled'),
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
      : state[key] === value);
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

async function clickSelectionTargetButton(page, language) {
  await activateInputPage(page);
  const {session, root} = await getSelectionUiTree(page);
  const button = findCdpNode(root, node => cdpAttribute(node, 'data-target-language') === language);
  if (!button) throw new Error(`找不到划词目标语言 ${language}`);
  const {model} = await session.send('DOM.getBoxModel', {nodeId: button.nodeId});
  const quad = model.border || model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
  await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1});
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
  const hoverStartedAt = Date.now();
  await page.mouse.move(hoverLayout.notice.x + hoverLayout.notice.width / 2,
    hoverLayout.notice.y + hoverLayout.notice.height / 2);
  await page.waitForTimeout(6500);
  assert(await notice.count() === 1 && await notice.isVisible(), '右键通知在鼠标阅读超过6秒时自动消失');
  const hoverHeldForMs = Date.now() - hoverStartedAt;
  await page.mouse.move(20, 800);
  const mouseLeftAt = Date.now();
  await notice.waitFor({state: 'detached', timeout: 6500});
  const remainingAfterLeaveMs = Date.now() - mouseLeftAt;
  const beforeHoverMs = hoverStartedAt - hoverStartedMessageAt;
  const expectedRemainderMs = 6000 - beforeHoverMs;
  assert(remainingAfterLeaveMs >= expectedRemainderMs - 500 && remainingAfterLeaveMs <= expectedRemainderMs + 850,
    `鼠标离开后未按剩余阅读时间关闭：${JSON.stringify({beforeHoverMs, hoverHeldForMs, remainingAfterLeaveMs, expectedRemainderMs})}`);
  result.cases.push({id: 'context-menu.notice-hover-pauses-and-resumes', status: 'passed',
    durationMs: 6000, beforeHoverMs, hoverHeldForMs, remainingAfterLeaveMs, expectedRemainderMs});

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
  const result = {
    ok: false,
    extensionDir: args.extensionDir,
    artifactsDir: args.artifactsDir,
    browser: 'Microsoft Edge',
    testScope: args.contextMenuOnly ? 'context-menu-only' : 'selection-trigger-filter-or-matrix',
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
    response.end(JSON.stringify((args.inlineCodeOnly || args.contextMenuOnly ? sources : [source]).map(text => ({ translations: [{ text: `测试译文：${text}${directionSuffix}` }] }))));
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
      if (args.contextMenuOnly) {
        const browserPid = await getGuardedBrowserPid(browserSession);
        result.ownedBrowserPid = browserPid;
        assertBackgroundFocus = async label => {
          const frontmost = await focusSafe.queryMacFrontmostApplication();
          assert(frontmost && Number.isSafeInteger(frontmost.pid) && frontmost.pid > 0
            && Number.isSafeInteger(browserPid) && browserPid > 0 && frontmost.pid !== browserPid,
          `右键专项焦点检查失败：${JSON.stringify({label, frontmost, browserPid})}`);
          (result.focusChecks ||= []).push({label, frontmost, browserFrontmost: false});
        };
        await assertBackgroundFocus('context-menu startup');
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
    const {worker, extensionId} = await waitForWorker(context);
    const attachWorkerDiagnostics = (target) => {
      target.on('console', (message) => {
        recordConsoleIssue(`worker ${message.type()}: ${message.text()}`);
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

    await context.route('https://example.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FluentRead selection fixture</title></head><body><main></main></body></html>',
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
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForContentScript(page);

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
      assert(chineseUi.direction.english && chineseUi.direction.chineseDisabled,
        `中文选区没有选中英语目标：${JSON.stringify(chineseUi.direction)}`);
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
      assert(englishUi.direction.chinese && englishUi.direction.englishDisabled,
        `英文选区没有选中中文目标：${JSON.stringify(englishUi.direction)}`);
      assert(englishUi.resultText.endsWith('[to=zh-Hans]'), `英文反向请求没有译为中文：${englishUi.resultText}`);
      result.cases.push({id:'direction.english-to-chinese',status:'passed',ui:englishUi});

      await patchStoredConfig(popup, {to:'zh-Hans'});
      await page.waitForTimeout(600);
      await select('Ceci est une phrase française complète.');
      await waitForSelectionUi(page, {indicator:true}, '法语选区显示划词图标');
      await clickSelectionIndicator(page);
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '法语默认翻译卡片');
      const beforeSwitch = translationRequestCount;
      await clickSelectionTargetButton(page, 'en');
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '临时切换英语目标');
      const switchedUi = await readSelectionUi(page);
      assert(switchedUi.direction.english && translationRequestCount === beforeSwitch + 1,
        `卡片切换目标没有重新请求：${JSON.stringify({direction:switchedUi.direction,beforeSwitch,translationRequestCount})}`);
      assert(switchedUi.resultText.endsWith('[to=en]'), `卡片切换没有使用新目标：${switchedUi.resultText}`);
      assert((await readStoredConfig(popup)).to === 'zh-Hans', '卡片切换修改了默认目标语言');
      result.cases.push({id:'direction.card-only-target',status:'passed',ui:switchedUi,requests:translationRequestCount-beforeSwitch});
      const switchScreenshot = path.join(args.artifactsDir,'direction-card-switch.png');
      await page.screenshot({path:switchScreenshot}); result.screenshots.push(switchScreenshot);

      translationResponseDelayMs = 700;
      await select('Une autre phrase française pour vérifier les réponses tardives.');
      await waitForSelectionUi(page, {indicator:true}, '延迟响应测试选区入口');
      const beforeRace = translationRequestCount;
      await clickSelectionIndicator(page);
      const raceDeadline = Date.now() + 3000;
      while (translationRequestCount === beforeRace && Date.now() < raceDeadline) await page.waitForTimeout(20);
      assert(translationRequestCount === beforeRace + 1, '切换前的翻译请求没有启动');
      await clickSelectionTargetButton(page, 'en');
      await waitForSelectionUi(page, {tooltip:true,translation:true,resultPrefix:'测试译文：'}, '切换后的翻译响应');
      await page.waitForTimeout(850);
      const raceUi = await readSelectionUi(page);
      assert(raceUi.direction.english && raceUi.resultText.endsWith('[to=en]'),
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
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
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
          const afterDrag = await gesture('.fr-tooltip-header', 60, 20);
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
      const moved = await gesture('.fr-tooltip-header', 160, -60);
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
      await gesture('.fr-tooltip-header', 2000, 2000);
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
      await gesture('.fr-tooltip-header', 60, 15, false);
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
      const loadingMoved = await gesture('.fr-tooltip-header', 60, 20);
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
      && directUi.brandIcon.present
      && directUi.brandIcon.src.includes('/icon/128.png')
      && directUi.copyButtons.source
      && directUi.copyButtons.translation,
    `翻译结果没有显示 FluentRead 图标或按内容卡提供独立复制入口：${JSON.stringify(directUi)}`);
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
