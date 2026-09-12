#!/usr/bin/env node

// 使用临时 Edge profile 验证划词翻译的完整触发矩阵。
// 该脚本只操作本次创建的隔离 profile，不连接用户正在使用的浏览器。

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const TARGET_TEXT = 'When switching between different filaments, the printer flushes residual material before printing.';
const CONFIG_FIXTURE_CLIENT_ID = `selection-trigger-${process.pid}-${Date.now()}`;
let configFixtureSequence = 0;
let activateInputPage = async () => undefined;
let createIsolatedPage = context => context.newPage();
const selectionUiSessions = new WeakMap();
const selectionUiTrackers = new WeakMap();

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
    focusSafeHelper: readArg(argv, 'focus-safe-helper', ''),
    headed: argv.includes('--headed'),
    chineseOnly: argv.includes('--chinese-only'),
    geometryOnly: argv.includes('--geometry-only'),
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

async function openSelectionDrawer(popup) {
  await popup.locator('.feature-card').filter({ hasText: '划词翻译' }).first().click();
  const drawer = popup.locator('.popup-drawer:visible').last();
  await drawer.getByText('触发方式', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  return drawer;
}

async function setSelectionEnabled(popup, drawer, enabled) {
  await activateInputPage(popup);
  const toggle = drawer.getByRole('switch', { name: '启用或关闭划词翻译' });
  const current = (await toggle.getAttribute('aria-checked')) === 'true';
  if (current !== enabled) {
    await toggle.click();
    await popup.waitForTimeout(500);
  }
  assert((await toggle.getAttribute('aria-checked')) === String(enabled), `划词翻译启用状态错误：${enabled}`);
}

async function setSelectionMode(popup, drawer, label) {
  await activateInputPage(popup);
  await drawer.locator('.chips.two button').filter({ hasText: label }).click();
  await popup.waitForTimeout(450);
  const selected = await drawer.locator('.chips.two button.selected').textContent();
  assert(selected?.includes(label), `显示方式没有选中 ${label}：${selected}`);
}

function expectedSelectionTrigger(label) {
  return label === '直接弹出'
    ? { trigger: 'direct', hotkey: 'none' }
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

async function waitForSelectionTriggerState(popup, drawer, storagePage, label, timeout = 10000) {
  const expected = expectedSelectionTrigger(label);
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    const selected = await drawer.locator('.selection-trigger-chips button.selected').textContent();
    const config = await readStoredConfig(storagePage);
    lastState = {
      selected,
      trigger: config.selectionTranslatorTrigger,
      hotkey: config.selectionTranslatorHotkey,
      customHotkey: config.customSelectionTranslatorHotkey || '',
    };
    if (selected?.includes(label)
      && config.selectionTranslatorTrigger === expected.trigger
      && config.selectionTranslatorHotkey === expected.hotkey
      && (label !== '自定义' || config.customSelectionTranslatorHotkey === 'F9')) {
      return { label, ...lastState };
    }
    await popup.waitForTimeout(100);
  }
  throw new Error(`选择 ${label} 后 UI/配置未稳定：${JSON.stringify(lastState)}`);
}

async function setSelectionTrigger(popup, drawer, storagePage, label) {
  await activateInputPage(popup);
  await drawer.locator('.selection-trigger-chips button').filter({ hasText: label }).click();
  await popup.waitForTimeout(500);

  if (label === '自定义') {
    let dialog = popup.locator('.custom-hotkey-dialog:visible').last();
    try {
      await dialog.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      const recordButton = drawer.getByRole('button', { name: /录制自定义快捷键|当前：/ });
      await recordButton.click();
      dialog = popup.locator('.custom-hotkey-dialog:visible').last();
    }
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await dialog.locator('.preset-button').filter({ hasText: 'F9' }).click();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await popup.waitForTimeout(600);
  }

  return waitForSelectionTriggerState(popup, drawer, storagePage, label);
}

async function setSelectionDelay(popup, drawer, storagePage, delay, settleMs = 500) {
  await activateInputPage(popup);
  const input = drawer.locator('input[aria-label="划词翻译显示延迟"]');
  await input.fill(String(delay));
  await input.press('Tab');
  await popup.waitForTimeout(settleMs);
  const config = await readStoredConfig(storagePage);
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
  const sourceCopyButton = findCdpNode(host, node => cdpAttribute(node, 'data-copy-kind') === 'source');
  const translationCopyButton = findCdpNode(host, node => cdpAttribute(node, 'data-copy-kind') === 'translation');
  const originalPre = findCdpDescendantByName(original, 'PRE');
  const translationPre = findCdpDescendantByName(translation, 'PRE');
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
    originalText: cdpText(originalPre).trim(),
    resultText: cdpText(translationPre).trim(),
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
  const next = { at: Date.now(), tooltip: state.tooltip, indicator: state.indicator };
  const previous = tracker.transitions.at(-1);
  if (!previous || previous.tooltip !== next.tooltip || previous.indicator !== next.indicator) {
    tracker.transitions.push(next);
  }
}

async function startSelectionUiTracking(page) {
  const previous = selectionUiTrackers.get(page);
  if (previous) clearInterval(previous.timer);
  const tracker = { transitions: [], timer: null, busy: false };
  await sampleSelectionUiTracker(page, tracker);
  tracker.timer = setInterval(async () => {
    if (tracker.busy) return;
    tracker.busy = true;
    try { await sampleSelectionUiTracker(page, tracker); } catch { /* 页面正在切换时忽略该次采样。 */ }
    tracker.busy = false;
  }, 25);
  selectionUiTrackers.set(page, tracker);
}

async function stopSelectionUiTracking(page) {
  const tracker = selectionUiTrackers.get(page);
  if (!tracker) return [];
  clearInterval(tracker.timer);
  while (tracker.busy) await page.waitForTimeout(5);
  await sampleSelectionUiTracker(page, tracker).catch(() => {});
  selectionUiTrackers.delete(page);
  return tracker.transitions;
}

async function exerciseTransientSelectionLoss(page, restoreDelayMs = 80) {
  await startSelectionUiTracking(page);
  await page.evaluate(async (delayMs) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) throw new Error('瞬时选区测试缺少活动选区');
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    selection.removeAllRanges();
    await new Promise(resolve => setTimeout(resolve, delayMs));
    for (const range of ranges) selection.addRange(range);
  }, restoreDelayMs);
  await page.waitForTimeout(350);
  const transitions = await stopSelectionUiTracking(page);
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
  let closeBrowser = async () => { if (context) await context.close().catch(() => {}); };
  const result = {
    ok: false,
    extensionDir: args.extensionDir,
    browser: 'Microsoft Edge',
    windowMode: args.headed ? 'headed-dedicated-profile' : 'background-visible-no-focus',
    cases: [],
    screenshots: [],
    consoleErrors: [],
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
  };
  let translationRequestCount = 0;
  const translationRequestEvents = [];
  let translationResponseDelayMs = 0;
  const translationServer = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/translate') {
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
    let source = '';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      source = Array.isArray(body) ? String(body[0] || '') : String(body?.[0] || body?.text || '');
    } catch {
      source = '';
    }
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify([{ translations: [{ text: `测试译文：${source}` }] }]));
  });
  await new Promise((resolve, reject) => {
    translationServer.once('error', reject);
    translationServer.listen(0, '127.0.0.1', resolve);
  });
  const translationAddress = translationServer.address();
  const translationFixtureUrl = `http://127.0.0.1:${translationAddress.port}/translate`;

  try {
    const browserArgs = [
      `--disable-extensions-except=${args.extensionDir}`,
      `--load-extension=${args.extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
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
      context = browserSession.context;
      closeBrowser = browserSession.close;
      createIsolatedPage = () => focusSafe.newPageWithoutForeground(context);
      activateInputPage = page => focusSafe.activateExtensionTabWithoutForeground(context, page);
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
      result.launchMode = 'playwright-headed';
      result.focusPolicy = 'foreground-authorized';
      result.windowPlacement = { mode: 'headed-explicit-foreground', windowState: 'normal', viewport: { width: 1280, height: 900 } };
    }
    const {worker, extensionId} = await waitForWorker(context);
    const attachWorkerDiagnostics = (target) => {
      target.on('console', (message) => {
        result.consoleErrors.push(`worker ${message.type()}: ${message.text()}`);
      });
    };
    attachWorkerDiagnostics(worker);
    const installTranslationFixture = (target) => target.evaluate((fixtureUrl) => {
      if (globalThis.__fluentReadSelectionFixtureFetchInstalled) return;
      const nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        return requestUrl.startsWith('https://edge.microsoft.com/translate/translatetext')
          ? nativeFetch(fixtureUrl, init)
          : nativeFetch(input, init);
      };
      globalThis.__fluentReadSelectionFixtureFetchInstalled = true;
    }, translationFixtureUrl);
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
    await patchStoredConfig(popup, {uiLanguageSetupCompleted: true});
    await popup.reload({waitUntil: 'domcontentloaded'});
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible'});

    const page = await createIsolatedPage(context);
    page.on('pageerror', (error) => result.consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(`console: ${message.text()}`); });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForContentScript(page);

    if (args.geometryOnly) {
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
        {id: 'card-hover', selectionTranslatorTrigger: 'icon', enabled: true, trigger: 'hover'},
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
      assert((await readSelectionUi(page)).readingIndicator, '外语翻译卡片入口未恢复');
      await select('你好');
      const finalUi = await readSelectionUi(page);
      assert(!finalUi.readingIndicator && !finalUi.tooltip, '中文翻译卡片入口未隐藏');
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
    await setSelectionEnabled(popup, drawer, true);
    await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'attached', timeout: 10000 });
    await setSelectionMode(popup, drawer, '双语显示');

    const initialDelayConfig = await readStoredConfig(popup);
    const initialDelayInput = await drawer.locator('input[aria-label="划词翻译显示延迟"]').inputValue();
    assert(initialDelayConfig.selectionTranslatorDelay === 300 && initialDelayInput === '300',
      `Popup 没有显示默认 300ms 延迟：${JSON.stringify({ stored: initialDelayConfig.selectionTranslatorDelay, input: initialDelayInput })}`);

    const drawerBody = popup.locator('.popup-drawer:visible .el-drawer__body');
    const drawerScroll = await drawerBody.evaluate((element) => {
      const before = { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
      element.scrollTop = element.scrollHeight;
      return { ...before, scrollTop: element.scrollTop };
    });
    await drawer.getByText('语音回退顺序', { exact: true }).scrollIntoViewIfNeeded();
    assert(await drawer.getByText('语音回退顺序', { exact: true }).isVisible(), 'Popup 抽屉滚动后仍看不到底部设置');
    const popupDelayScreenshot = path.join(args.artifactsDir, 'popup-selection-delay.png');
    await popup.screenshot({ path: popupDelayScreenshot });
    result.screenshots.push(popupDelayScreenshot);
    result.cases.push({ id: 'ui.popup-scrolls-to-bottom', status: 'passed', drawerScroll });

    const optionsPage = await createIsolatedPage(context);
    optionsPage.on('pageerror', (error) => result.consoleErrors.push(`options pageerror: ${error.message}`));
    optionsPage.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(`options console: ${message.text()}`); });
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html#settings-translation`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
    assert(await optionsDelayInput.inputValue() === '300', `完整配置页延迟值错误：${await optionsDelayInput.inputValue()}`);
    await optionsDelayInput.fill('450');
    await optionsDelayInput.press('Tab');
    await optionsPage.waitForTimeout(700);
    assert((await readStoredConfig(popup)).selectionTranslatorDelay === 450, '完整配置页没有保存 450ms 延迟');
    await popup.waitForFunction(() => document.querySelector('input[aria-label="划词翻译显示延迟"]')?.value === '450');
    const optionsDelayScreenshot = path.join(args.artifactsDir, 'options-selection-delay.png');
    await optionsPage.screenshot({ path: optionsDelayScreenshot });
    result.screenshots.push(optionsDelayScreenshot);
    result.cases.push({ id: 'ui.options-popup-delay-persistence', status: 'passed', configuredDelay: 450 });
    await optionsPage.close();
    await setSelectionDelay(popup, drawer, popup, 300);

    // 显示延迟：计时期间不显示 UI、不发翻译请求；改选后旧计时器必须失效。
    await setSelectionDelay(popup, drawer, popup, 800);
    await setSelectionTrigger(popup, drawer, popup, '直接弹出');
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
    await setSelectionDelay(popup, drawer, popup, 1000);
    await setSelectionTrigger(popup, drawer, popup, 'Ctrl');
    await resetFixture(page);
    const shortcutDelayRequestsBefore = translationRequestCount;
    await selectTextWithDomRange(page, '#target');
    await triggerShortcut(page, 'Ctrl', 250);
    const duringShortcutDelay = await readSelectionUi(page);
    assert(!duringShortcutDelay.indicator && !duringShortcutDelay.tooltip, '快捷键在剩余延迟结束前提前显示了翻译框');
    assert(translationRequestCount === shortcutDelayRequestsBefore, '快捷键等待期间提前发起了翻译请求');
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '快捷键等待剩余延迟后显示翻译框');
    result.cases.push({ id: 'delay.shortcut-waits-remaining-time', status: 'passed', duringDelay: duringShortcutDelay });

    // Popup 在线修改延迟后，当前页面按原选区时间重算剩余时长，无需刷新。
    await closeSelectionUi(page);
    await setSelectionTrigger(popup, drawer, popup, '直接弹出');
    await resetFixture(page);
    await selectTextWithDomRange(page, '#target');
    await page.waitForTimeout(150);
    assert(!(await readSelectionUi(page)).tooltip, '在线修改延迟前翻译框已提前显示');
    await setSelectionDelay(popup, drawer, popup, 200, 100);
    await waitForSelectionUi(page, { tooltip: true, indicator: false, translation: true }, '在线缩短延迟后显示当前选区');
    result.cases.push({ id: 'delay.live-popup-reschedule', status: 'passed', configuredDelay: 200 });

    await closeSelectionUi(page);
    await setSelectionDelay(popup, drawer, popup, 0);
    await patchStoredConfig(popup, { to: 'fr' });
    await page.waitForTimeout(700);
    await setSelectionTrigger(popup, drawer, popup, '直接弹出');
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
    await setSelectionDelay(popup, drawer, popup, 300);

    // 原生三击：普通段落和 JetBrains 评论形状都应显示入口。
    // JetBrains 形状的 Range 会夹带一个 display:none 的 button，但可见选区只有正文。
    await closeSelectionUi(page);
    await setSelectionDelay(popup, drawer, popup, 0);
    const tripleClickPopupState = await setSelectionTrigger(popup, drawer, popup, '显示图标');

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
    await setSelectionDelay(popup, drawer, popup, 300);

    // 视觉触发方式：Popup 改设置后不刷新页面，真实鼠标划词仍应反映新模式。
    for (const mode of [
      { label: '显示图标', className: 'fr-selection-indicator fr-selection-indicator--icon' },
      { label: '显示小点', className: 'fr-selection-indicator fr-selection-indicator--dot' },
    ]) {
      await closeSelectionUi(page);
      const popupState = await setSelectionTrigger(popup, drawer, popup, mode.label);
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
    const directPopupState = await setSelectionTrigger(popup, drawer, popup, '直接弹出');
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
    await setSelectionMode(popup, drawer, '仅译文');
    await setSelectionTrigger(popup, drawer, popup, '直接弹出');
    await resetFixture(page);
    await selectTarget(page);
    await waitForSelectionUi(page, { tooltip: true, original: false, translation: true, resultPrefix: '测试译文：' }, '仅译文模式');
    const translationOnlyUi = await readSelectionUi(page);
    assert(translationOnlyUi.targetText === TARGET_TEXT && translationOnlyUi.translation && !translationOnlyUi.original && translationOnlyUi.resultText.startsWith('测试译文：'), '仅译文模式渲染不完整或改写了页面正文');
    result.cases.push({ id: 'display.translation-only', status: 'passed', ui: translationOnlyUi });

    await closeSelectionUi(page);
    await setSelectionMode(popup, drawer, '双语显示');
    await resetFixture(page);
    await selectTarget(page);
    await waitForSelectionUi(page, { tooltip: true, original: true, translation: true, resultPrefix: '测试译文：' }, '双语显示模式');
    const bilingualUi = await readSelectionUi(page);
    assert(bilingualUi.targetText === TARGET_TEXT && bilingualUi.original && bilingualUi.translation && bilingualUi.resultText.startsWith('测试译文：'), '双语模式渲染不完整或改写了页面正文');
    result.cases.push({ id: 'display.bilingual', status: 'passed', ui: bilingualUi });

    // 关闭/重新启用：关闭后不再挂载划词 UI，重新启用后恢复。
    await closeSelectionUi(page);
    await setSelectionEnabled(popup, drawer, false);
    await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'detached', timeout: 10000 });
    result.cases.push({ id: 'selection.disabled', status: 'passed' });
    await setSelectionEnabled(popup, drawer, true);
    await page.locator('#fluent-read-selection-translator-container').waitFor({ state: 'attached', timeout: 10000 });
    result.cases.push({ id: 'selection.re-enabled', status: 'passed' });

    // 预设快捷键：选区旁不显示图标/小点，按对应键后直接打开翻译框。
    for (const label of ['Ctrl', 'Alt / Option', 'Shift']) {
      await closeSelectionUi(page);
      const popupState = await setSelectionTrigger(popup, drawer, popup, label);
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
    const conflictPopupState = await setSelectionTrigger(popup, drawer, popup, 'Ctrl');
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

    // 划词与全文共享快捷键、但悬浮不共享时：没有选区应在 keyup 回退全文翻译。
    await closeSelectionUi(page);
    await patchStoredConfig(popup, { hotkey: 'none', customHotkey: '', floatingBallHotkey: 'Control' });
    await page.waitForTimeout(700);
    await resetFixture(page);
    await clearPageSelection(page);
    await activateInputPage(page);
    await page.keyboard.press('Control');
    await page.waitForFunction(() => document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length >= 2, undefined, { timeout: 10000 });
    const fullPageDomState = await page.evaluate(() => ({
      translatedCount: document.querySelectorAll('#selection-test-fixture .fluent-read-bilingual-content').length,
    }));
    const fullPageSelectionState = await readSelectionUi(page);
    const fullPageFallback = { ...fullPageDomState, selectionTooltip: fullPageSelectionState.tooltip };
    assert(!fullPageFallback.selectionTooltip, `无选区全文回退时误开划词翻译：${JSON.stringify(fullPageFallback)}`);
    result.cases.push({ id: 'conflict.full-page-fallback-without-selection-or-hover', status: 'passed', ui: fullPageFallback });
    await page.keyboard.press('Control');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0, undefined, { timeout: 10000 });

    await closeSelectionUi(page);
    const customPopupState = await setSelectionTrigger(popup, drawer, popup, '自定义');
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
      const popupState = await setSelectionTrigger(popup, drawer, popup, conflictCase.label);
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
    }

    result.finalConfig = await readStoredConfig(popup);
    result.ok = result.cases.every(item => item.status === 'passed') && result.consoleErrors.length === 0;
    if (!result.ok) throw new Error(`划词浏览器回归未通过：${JSON.stringify({consoleErrors: result.consoleErrors})}`);
    fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    result.error = error.stack || error.message || String(error);
    fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
    await new Promise(resolve => translationServer.close(resolve));
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
