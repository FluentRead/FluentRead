'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);

const macFrontmostApplicationScript = [
  "ObjC.import('AppKit');",
  'const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
  "JSON.stringify({ pid: Number(app.processIdentifier), name: ObjC.unwrap(app.localizedName) || '' });",
].join('\n');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(argument('playwright-root', ''));
// 统一回归 runner 使用 --focus-safe-helper；旧的 --focus-helper 仅保留为本脚本的兼容别名。
const focusHelper = path.resolve(argument('focus-safe-helper', argument('focus-helper', '')));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-settings-center-ui'));
const browserPath = argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const timeout = Number(argument('timeout', '30000'));

function parseHexColor(value) {
  const raw = String(value || '').trim().replace(/^#/u, '');
  const normalized = raw.length === 3 ? [...raw].map(char => `${char}${char}`).join('') : raw;
  if (!/^[\da-f]{6}$/iu.test(normalized)) return null;
  return [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function parseCssColor(value) {
  const hex = parseHexColor(value);
  if (hex) return hex;
  const match = /^rgba?\(([^)]+)\)$/iu.exec(String(value || '').trim());
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,/]+/u);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = part => /^\d*\.?\d+%?$/u.test(part)
    ? Number.parseFloat(part) * (part.endsWith('%') ? 2.55 : 1)
    : NaN;
  const channels = parts.slice(0, 3).map(channel);
  if (channels.some(item => !Number.isFinite(item) || item < 0 || item > 255)) return null;
  if (parts.length === 4) {
    const alpha = channel(parts[3]) / (parts[3].endsWith('%') ? 255 : 1);
    // 透明色必须先与实际底色合成；本检查只接受不透明的真实按钮颜色，避免误报通过。
    if (!Number.isFinite(alpha) || Math.abs(alpha - 1) > .00001) return null;
  }
  return channels;
}

function contrastRatio(foreground, background) {
  const colors = [foreground, background].map(parseCssColor);
  if (colors.some(color => color === null)) return 0;
  const luminance = color => color
    .map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const [first, second] = colors.map(luminance).sort((left, right) => right - left);
  return (first + .05) / (second + .05);
}
const expectedNavigation = [
  ['settings-general', '通用设置'],
  ['settings-interface', '界面布局'],
  ['settings-services', '翻译服务'],
  ['settings-translation', '翻译设置'],
  ['settings-harness', '翻译卡'],
  ['settings-image-translation', '图片翻译'],
  ['settings-area-translation', '圈选翻译'],
  ['settings-video', '视频字幕翻译'],
  ['settings-sites', '网站规则'],
  ['settings-translation-center', '翻译中心'],
  ['settings-vocabulary', '学习中心'],
  ['settings-glossary', '术语库'],
  ['settings-model-usage', '模型用量'],
  ['settings-advanced', '高级选项'],
  ['settings-data', '备份与恢复'],
  ['settings-about', '关于流畅阅读'],
];
const expectedNavigationGroups = [
  ['基础配置', ['settings-general', 'settings-interface', 'settings-services', 'settings-translation']],
  ['专项翻译', ['settings-harness', 'settings-image-translation', 'settings-area-translation', 'settings-video', 'settings-sites']],
  ['工具与学习', ['settings-translation-center', 'settings-vocabulary', 'settings-glossary', 'settings-model-usage']],
  ['系统与数据', ['settings-advanced', 'settings-data', 'settings-about']],
];
const expectedGeneralGroups = ['选择翻译服务', '译文显示', '网页辅助'];
const expectedInterfaceGroups = ['界面与弹窗', '动画与加载效果', '菜单栏布局'];
const expectedTranslationGroups = ['鼠标悬浮翻译', '划词翻译', '输入框翻译', '全文翻译'];
const expectedLoadingStyles = [
  ['minimal', '简洁'],
  ['ring', '柔和圆环'],
  ['dots', '跳跃圆点'],
  ['orbit', '行星轨道'],
  ['sparkle', '星光'],
  ['pulse', '涟漪扩散'],
  ['wave', '起伏波形'],
  ['sweep', '光线扫过'],
  ['hourglass', '流沙沙漏'],
  ['comet', '小彗星'],
  ['flip', '翻转方块'],
  ['bounce', '弹跳小球'],
  ['typing', '打字光标'],
  ['scan', '扫描线'],
  ['signal', '信号柱'],
];
const configDatabaseName = 'FluentReadConfiguration';
const expectedEncryptedRecordKeys = [
  'local:config',
  'local:configHistory',
  'local:configAutoBackups',
  'local:credentials',
];
const legacyLocalStorageKeys = [
  'config', 'local:config',
  'configHistory', 'local:configHistory',
  'configAutoBackups', 'local:configAutoBackups',
  'credentials', 'local:credentials',
  'fluentReadImageOcrLanguages', 'local:fluentReadImageOcrLanguages',
];
const legacySessionStorageKeys = ['credentials', 'session:credentials'];
const legacyMigrationSentinels = {
  token: 'legacy-session-openai-token-sensitive-sentinel',
  appid: 'legacy-session-appid-sensitive-sentinel',
  key: 'legacy-session-key-sensitive-sentinel',
  userRole: 'legacy-user-role-sensitive-sentinel {{text}}',
  systemRole: 'legacy-system-role-sensitive-sentinel',
};

if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`扩展产物不存在：${extensionDir}`);
if (!fs.existsSync(focusHelper)) throw new Error(`防抢焦点 helper 不存在：${focusHelper}`);
fs.mkdirSync(artifactsDir, {recursive: true});

const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {
  activateExtensionTabWithoutForeground,
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
} = require(focusHelper);

async function readMacFrontmostApplication() {
  if (process.platform !== 'darwin') return null;
  const {stdout} = await execFileAsync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    macFrontmostApplicationScript,
  ], {timeout: 5000});
  const application = JSON.parse(stdout.trim());
  return Number.isInteger(application?.pid) && application.pid > 0 ? application : null;
}

async function readTestBrowserPid(context) {
  const browser = context.browser();
  if (!browser) throw new Error('无法获取隔离浏览器实例；无法执行复用页签的焦点校验');
  const session = await browser.newBrowserCDPSession();
  try {
    const {processInfo} = await session.send('SystemInfo.getProcessInfo');
    const pid = processInfo.find(process => process.type === 'browser')?.id;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('无法确认测试 Edge 的精确进程 ID；焦点校验已停止');
    return pid;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function assertTestBrowserRemainsBackground(context, label) {
  const [browserPid, frontmost] = await Promise.all([
    readTestBrowserPid(context),
    readMacFrontmostApplication(),
  ]);
  if (!frontmost) throw new Error(`无法读取 macOS 前台应用（${label}）；焦点校验已停止`);
  if (frontmost.pid === browserPid) {
    throw new Error(`测试 Edge 进程 ${browserPid} 成为了前台应用（${label}）；测试已停止`);
  }
}

async function settleFiniteUiAnimations(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const finite = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finite.map(animation => animation.finished));
  });
}

async function screenshot(page, file) {
  await settleFiniteUiAnimations(page);
  const target = path.join(artifactsDir, file);
  await page.screenshot({path: target, fullPage: false});
  return target;
}

async function screenshotElement(locator, file) {
  await settleFiniteUiAnimations(locator.page());
  const target = path.join(artifactsDir, file);
  await locator.screenshot({path: target});
  return target;
}

async function dragWholeElement(page, source, target, axis = 'y', position = 'before') {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBounds = await source.boundingBox();
  const targetBounds = await target.boundingBox();
  if (!sourceBounds || !targetBounds) throw new Error('原生鼠标拖放目标不可见');
  const sourcePoint = {
    x: sourceBounds.x + sourceBounds.width / 2,
    y: sourceBounds.y + sourceBounds.height / 2,
  };
  const targetPoint = axis === 'x'
    ? {
        x: targetBounds.x + (position === 'after' ? targetBounds.width - 4 : 4),
        y: targetBounds.y + targetBounds.height / 2,
      }
    : {
        x: targetBounds.x + targetBounds.width / 2,
        y: targetBounds.y + (position === 'after' ? targetBounds.height - 4 : 4),
      };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + (axis === 'x' ? 8 : 0), sourcePoint.y + (axis === 'y' ? 8 : 0), {steps: 8});
  await page.mouse.move(targetPoint.x, targetPoint.y, {steps: 16});
  await page.mouse.up();
}

// 横向失败保留即时和过渡结束后的真实 DOM；只补诊断，不依据延迟读数放过失败。
async function capturePopupOverflowFailure(page, label) {
  const inspect = () => page.locator('.popup-shell').evaluate(element => {
    const describe = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName,
        className: node.className,
        text: node.textContent?.trim().slice(0, 100),
        rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height},
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        transform: style.transform,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        width: style.width,
        minWidth: style.minWidth,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
      };
    };
    const shell = describe(element);
    const initialScrollTop = element.scrollTop;
    const initialScrollLeft = element.scrollLeft;
    let reachableScrollLeft;
    try {
      element.scrollTo({top: initialScrollTop, left: element.scrollWidth, behavior: 'instant'});
      reachableScrollLeft = element.scrollLeft;
    } finally {
      element.scrollTo({top: initialScrollTop, left: initialScrollLeft, behavior: 'instant'});
    }
    return {
      shell,
      initialScrollLeft,
      reachableScrollLeft,
      restoredScrollLeft: element.scrollLeft,
      elements: [...element.querySelectorAll('*')].map(describe)
        .filter(node => node.rect.width > 0 && node.rect.height > 0 && (
          node.scrollWidth > node.clientWidth + 1
          || node.rect.right > shell.rect.right + 1
          || node.rect.left < shell.rect.left - 1
        )),
      animations: element.getAnimations({subtree: true}).map(animation => ({
        playState: animation.playState,
        currentTime: animation.currentTime,
        target: animation.effect?.target?.className,
        timing: animation.effect?.getComputedTiming(),
      })),
    };
  });
  const before = await inspect();
  const beforeScreenshot = await screenshot(page, 'failure-popup-overflow-before.png');
  await page.waitForTimeout(800);
  const after = await inspect();
  const afterScreenshot = await screenshot(page, 'failure-popup-overflow-after.png');
  const file = path.join(artifactsDir, 'failure-popup-overflow-diagnostics.json');
  fs.writeFileSync(file, JSON.stringify({label, before, after, waitedMs: 800, beforeScreenshot, afterScreenshot}, null, 2));
  return {file, beforeScreenshot, afterScreenshot};
}

// 扩展页在固定测试 viewport 中也必须按内容排版；documentElement.scrollHeight 至少等于
// viewport 高度，不能据此推断 Popup 的自然高度。短内容检查整条高度链及底部留白；
// 长内容按生产的 560px 内部滚动契约检查末尾可达性，不能把初始位置的底栏越界当作裁切。
async function inspectPopupContentHeight(page, label) {
  const metrics = await page.locator('.popup-shell').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const shellStyle = getComputedStyle(element);
    const app = document.querySelector('#app');
    const lastModule = [...element.querySelectorAll('.popup-content > [data-popup-module]')].at(-1);
    const lastRect = lastModule?.getBoundingClientRect();
    const lastStyle = lastModule ? getComputedStyle(lastModule) : null;
    const initialScrollTop = element.scrollTop;
    const initialScrollLeft = element.scrollLeft;
    const scrolling = {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      maxHeight: Number.parseFloat(shellStyle.maxHeight),
      overflowY: shellStyle.overflowY,
      initialScrollTop,
      // scrollHeight/clientHeight 已取整；即使仅多 1px，也需要验证滚动到底。
      longContent: element.scrollHeight > element.clientHeight,
      horizontalOverflow: [document.documentElement, document.body, app, element]
        .filter(Boolean).some(node => node.scrollWidth > node.clientWidth + 1),
      end: null,
      restoredScrollTop: initialScrollTop,
    };
    if (scrolling.longContent) {
      try {
        element.scrollTo({top: element.scrollHeight, left: initialScrollLeft, behavior: 'instant'});
        const endRect = lastModule?.getBoundingClientRect();
        scrolling.end = {
          scrollTop: element.scrollTop,
          maxScrollTop: element.scrollHeight - element.clientHeight,
          lastModuleTop: endRect?.top ?? null,
          lastModuleBottom: endRect?.bottom ?? null,
          viewportTop: rect.top + element.clientTop,
          viewportBottom: rect.top + element.clientTop + element.clientHeight,
          lastModuleBottomGap: endRect ? rect.bottom - endRect.bottom : null,
        };
      } finally {
        element.scrollTo({top: initialScrollTop, left: initialScrollLeft, behavior: 'instant'});
        scrolling.restoredScrollTop = element.scrollTop;
      }
    }
    return {
      shellHeight: rect.height,
      shellBottom: rect.bottom,
      htmlHeight: document.documentElement.getBoundingClientRect().height,
      bodyHeight: document.body.getBoundingClientRect().height,
      appHeight: app?.getBoundingClientRect().height || 0,
      heightMode: document.documentElement.dataset.popupHeight,
      htmlMinHeight: getComputedStyle(document.documentElement).minHeight,
      bodyMinHeight: getComputedStyle(document.body).minHeight,
      appMinHeight: app ? getComputedStyle(app).minHeight : null,
      shellMinHeight: shellStyle.minHeight,
      lastModule: lastModule?.getAttribute('data-popup-module') || null,
      lastModuleBottomGap: lastRect ? rect.bottom - lastRect.bottom : null,
      expectedBottomGap: lastStyle
        ? Number.parseFloat(shellStyle.paddingBottom) + Number.parseFloat(shellStyle.borderBottomWidth)
          + Number.parseFloat(lastStyle.marginBottom)
        : null,
      visibleQuickFeatures: element.querySelectorAll('[data-popup-quick-feature]').length,
      scrolling,
    };
  });
  // 短内容也检查内部横向范围，不能依赖外层 overflow-x:hidden 掩盖底栏越界。
  if (metrics.scrolling.horizontalOverflow) {
    metrics.failureDiagnostics = await capturePopupOverflowFailure(page, label);
    throw new Error(`${label}存在内部横向溢出：${JSON.stringify(metrics)}`);
  }
  if (metrics.heightMode !== 'content'
    || [metrics.htmlMinHeight, metrics.bodyMinHeight, metrics.appMinHeight, metrics.shellMinHeight]
      .some(value => value !== '0px')
    || !Number.isFinite(metrics.shellHeight) || metrics.shellHeight <= 0
    || [metrics.htmlHeight, metrics.bodyHeight, metrics.appHeight]
      .some(height => Math.abs(height - metrics.shellHeight) > 1)
    || !metrics.lastModule
    || !Number.isFinite(metrics.lastModuleBottomGap)
    || !Number.isFinite(metrics.expectedBottomGap)
    || (!metrics.scrolling.longContent
      && Math.abs(metrics.lastModuleBottomGap - metrics.expectedBottomGap) > 1)) {
    throw new Error(`${label}没有按内容确定高度或底部留下额外空白：${JSON.stringify(metrics)}`);
  }
  const {scrolling} = metrics;
  if (scrolling.longContent && (
    metrics.shellHeight > 561
    || scrolling.maxHeight !== 560
    || !['auto', 'scroll'].includes(scrolling.overflowY)
    || !scrolling.end
    || scrolling.end.scrollTop <= 0
    || Math.abs(scrolling.end.scrollTop - scrolling.end.maxScrollTop) > 1
    || !Number.isFinite(scrolling.end.lastModuleTop)
    || !Number.isFinite(scrolling.end.lastModuleBottom)
    || scrolling.end.lastModuleTop < scrolling.end.viewportTop - 1
    || scrolling.end.lastModuleBottom > scrolling.end.viewportBottom + 1
    || Math.abs(scrolling.end.lastModuleBottomGap - metrics.expectedBottomGap) > 1
    || Math.abs(scrolling.restoredScrollTop - scrolling.initialScrollTop) > 1
  )) {
    throw new Error(`${label}没有满足560px内部滚动、末尾完整可见及位置恢复：${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function inspectInterfaceMotif(locator, skin) {
  const metrics = await locator.evaluate(element => {
    const motifs = [...element.querySelectorAll(':scope > [data-interface-motif]')];
    return motifs.map(motif => {
      const style = getComputedStyle(motif);
      const rect = motif.getBoundingClientRect();
      return {
        motif: motif.getAttribute('data-interface-motif'),
        ariaHidden: motif.getAttribute('aria-hidden'),
        pointerEvents: style.pointerEvents,
        position: style.position,
        opacity: Number(style.opacity),
        width: rect.width,
        height: rect.height,
        graphics: motif.querySelectorAll('svg path, svg circle, svg ellipse, .emoji-stickers span').length,
      };
    });
  });
  if (skin.kind === 'palette') {
    const motif = metrics[0];
    if (metrics.length !== 1 || motif.motif !== skin.value || motif.ariaHidden !== 'true'
      || motif.pointerEvents !== 'none' || motif.position !== 'absolute'
      || motif.opacity <= 0 || motif.width <= 0 || motif.height <= 0 || motif.graphics === 0) {
      throw new Error(`${skin.label}缺少可见但不妨碍操作的主题图案：${JSON.stringify(metrics)}`);
    }
  } else if (metrics.length !== 0) {
    throw new Error(`${skin.label}不应增加氛围皮肤的主题图案：${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function verifyInterfaceDesignMatrix(page, skin, report) {
  const cases = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    for (const viewport of [
      {width: 1440, height: 1000},
      {width: 820, height: 900},
      {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('button[data-section="settings-interface"]').click();
      await page.locator('.interface-skin-live-preview').scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        const bounds = element => {
          const rect = element.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width > 0;
        };
        return {
          horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
          selectedSkin: root.dataset.interfaceSkin,
          cardCount: document.querySelectorAll('.interface-skin-option').length,
          cardsWithinViewport: [...document.querySelectorAll('.interface-skin-option')].every(bounds),
          previewWithinViewport: bounds(document.querySelector('.interface-skin-live-preview')),
          groupsWithinViewport: [...document.querySelectorAll('#settings-interface .settings-group')].every(bounds),
          workspaceBackgroundImage: getComputedStyle(document.querySelector('.workspace')).backgroundImage,
          ink: style.getPropertyValue('--ink').trim(),
          surface: style.getPropertyValue('--surface').trim(),
        };
      });
      metrics.textContrast = contrastRatio(metrics.ink, metrics.surface);
      if (metrics.horizontalOverflow || metrics.selectedSkin !== skin.value || metrics.cardCount !== 14
        || !metrics.cardsWithinViewport || !metrics.previewWithinViewport || !metrics.groupsWithinViewport
        || metrics.textContrast < 4.5 || (skin.kind === 'palette' && metrics.workspaceBackgroundImage === 'none')) {
        throw new Error(`${skin.label} ${theme} ${viewport.width}px 界面布局异常：${JSON.stringify(metrics)}`);
      }
      const workspaceMotif = await inspectInterfaceMotif(page.locator('.workspace'), skin);
      const previewMotif = await inspectInterfaceMotif(page.locator('.interface-skin-live-preview .preview-popup'), skin);
      const cardMotif = await inspectInterfaceMotif(page.locator(`.interface-skin-option[data-skin="${skin.value}"] .interface-skin-preview`), skin);
      report.screenshots.push(await screenshot(page, `settings-design-${skin.value}-${theme}-${viewport.width}.png`));
      const workbench = page.locator('[data-popup-layout-workbench]');
      await workbench.scrollIntoViewIfNeeded();
      const layoutMetrics = await workbench.evaluate(element => {
        const within = target => {
          const rect = target.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width > 0;
        };
        const preview = element.querySelector('.popup-layout-live-preview');
        const panel = element.querySelector('.popup-layout-control-panel');
        return {
          workbenchWithinViewport: within(element),
          previewWithinViewport: within(preview),
          controlsWithinViewport: within(panel),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          moduleCount: preview.querySelectorAll('[data-preview-popup-module]').length,
          featureCount: preview.querySelectorAll('[data-preview-quick-feature]').length,
        };
      });
      if (!layoutMetrics.workbenchWithinViewport || !layoutMetrics.previewWithinViewport
        || !layoutMetrics.controlsWithinViewport || layoutMetrics.horizontalOverflow
        || layoutMetrics.moduleCount !== 4 || layoutMetrics.featureCount !== 7) {
        throw new Error(`${skin.label} ${theme} ${viewport.width}px 菜单栏工作台异常：${JSON.stringify(layoutMetrics)}`);
      }
      const layoutMotif = await inspectInterfaceMotif(page.locator('.popup-layout-live-preview .layout-preview-popup'), skin);
      report.screenshots.push(await screenshot(page, `settings-menu-layout-${skin.value}-${theme}-${viewport.width}.png`));
      if (viewport.width === 1440) {
        report.screenshots.push(await screenshotElement(page.locator('.interface-skin-live-preview'), `settings-design-preview-${skin.value}-${theme}.png`));
        report.screenshots.push(await screenshotElement(page.locator('.popup-layout-live-preview'), `settings-design-layout-preview-${skin.value}-${theme}.png`));
      }
      cases.push({theme, ...viewport, metrics, layoutMetrics, workspaceMotif, previewMotif, cardMotif, layoutMotif});
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewportSize({width: 1440, height: 1000});
  return cases;
}

async function verifyBilingualHighlightPreview(page) {
  const preview = page.getByTestId('bilingual-highlight-preview');
  const source = page.getByTestId('bilingual-highlight-preview-source');
  const translation = page.getByTestId('bilingual-highlight-preview-translation');
  const toggle = page.getByRole('switch', {name: '双语逐句高亮', exact: true});
  await preview.waitFor({state: 'visible', timeout});
  if (await source.count() !== 1 || await translation.count() !== 1 || await toggle.count() !== 1) {
    throw new Error('双语逐句高亮预览缺少唯一的原文、译文或开关');
  }

  const initialEnabled = await toggle.getAttribute('aria-checked') === 'true';
  if (initialEnabled) {
    await toggle.locator('..').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="bilingual-highlight-preview"]')
        ?.getAttribute('data-bilingual-highlight-enabled') === 'false', undefined, {timeout});
  }

  const readState = () => preview.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const source = element.querySelector('[data-testid="bilingual-highlight-preview-source"]');
    const translation = element.querySelector('[data-testid="bilingual-highlight-preview-translation"]');
    const sourceMarker = source ? getComputedStyle(source, '::before') : null;
    const translationMarker = translation ? getComputedStyle(translation, '::before') : null;
    const sourceStyle = source ? getComputedStyle(source) : null;
    const translationStyle = translation ? getComputedStyle(translation) : null;
    return {
      enabled: element.getAttribute('data-bilingual-highlight-enabled'),
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      sourceMarker: sourceMarker ? {
        content: sourceMarker.content,
        width: sourceMarker.width,
        backgroundColor: sourceMarker.backgroundColor,
      } : null,
      translationMarker: translationMarker ? {
        content: translationMarker.content,
        width: translationMarker.width,
        backgroundColor: translationMarker.backgroundColor,
      } : null,
      sourceTextStyle: sourceStyle ? {color: sourceStyle.color, fontSize: sourceStyle.fontSize} : null,
      translationTextStyle: translationStyle ? {
        color: translationStyle.color,
        fontSize: translationStyle.fontSize,
      } : null,
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    };
  });
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(220);
  const before = await readState();
  if (!before.sourceTextStyle || !before.translationTextStyle ||
      before.sourceTextStyle.fontSize === before.translationTextStyle.fontSize ||
      before.sourceTextStyle.color === before.translationTextStyle.color) {
    throw new Error(`双语预览未清楚区分原文与译文层级：${JSON.stringify(before)}`);
  }
  await source.hover();
  await page.waitForTimeout(180);
  const disabledHover = await readState();
  if (disabledHover.backgroundColor !== before.backgroundColor ||
      disabledHover.boxShadow !== before.boxShadow ||
      disabledHover.translationMarker?.content !== 'none') {
    throw new Error(`关闭双语逐句高亮后预览仍响应 hover：${JSON.stringify({before, disabledHover})}`);
  }

  await toggle.locator('..').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="bilingual-highlight-preview"]')
      ?.getAttribute('data-bilingual-highlight-enabled') === 'true', undefined, {timeout});
  await source.hover();
  await page.waitForTimeout(180);
  const sourceHover = await readState();
  await translation.hover();
  await page.waitForTimeout(180);
  const translationHover = await readState();
  await page.mouse.move(0, 0);
  await toggle.focus();
  await page.keyboard.press('Tab');
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute('data-testid') === 'bilingual-highlight-preview', undefined, {timeout});
  await page.waitForTimeout(180);
  const keyboardFocus = await readState();
  const geometryDelta = Math.max(...[sourceHover, translationHover, keyboardFocus].flatMap((state) => [
    Math.abs(state.rect.x - before.rect.x),
    Math.abs(state.rect.y - before.rect.y),
    Math.abs(state.rect.width - before.rect.width),
    Math.abs(state.rect.height - before.rect.height),
  ]));
  const transparent = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  if (transparent.has(sourceHover.backgroundColor) ||
      sourceHover.backgroundColor === before.backgroundColor ||
      sourceHover.backgroundColor !== translationHover.backgroundColor ||
      sourceHover.boxShadow !== translationHover.boxShadow ||
      sourceHover.backgroundColor !== keyboardFocus.backgroundColor ||
      sourceHover.boxShadow !== keyboardFocus.boxShadow ||
      sourceHover.sourceMarker?.content !== 'none' ||
      !sourceHover.translationMarker ||
      sourceHover.translationMarker.content === 'none' ||
      sourceHover.translationMarker.width !== '2px' ||
      transparent.has(sourceHover.translationMarker.backgroundColor) ||
      JSON.stringify(sourceHover.translationMarker) !== JSON.stringify(translationHover.translationMarker) ||
      JSON.stringify(sourceHover.translationMarker) !== JSON.stringify(keyboardFocus.translationMarker)) {
    throw new Error(`双语逐句高亮预览的原文、译文和键盘焦点效果不一致：${JSON.stringify({before, sourceHover, translationHover, keyboardFocus})}`);
  }
  if (geometryDelta > 0.5) throw new Error(`双语逐句高亮预览改变了几何尺寸：${geometryDelta}px`);

  const screenshot = await screenshotElement(preview, 'settings-bilingual-highlight-preview.png');
  if (!initialEnabled) {
    await toggle.locator('..').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="bilingual-highlight-preview"]')
        ?.getAttribute('data-bilingual-highlight-enabled') === 'false', undefined, {timeout});
  }
  await page.mouse.move(0, 0);

  return {
    initialEnabled,
    disabledHover,
    sourceHover,
    translationHover,
    keyboardFocus,
    geometryDelta,
    screenshot,
  };
}

async function seedModelUsageFixture(page) {
  return page.evaluate(async () => {
    const now = Date.now();
    const localDay = daysAgo => {
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);
      date.setHours(12, 0, 0, 0);
      return date.getTime();
    };
    const base = {
      schemaVersion: 1,
      durationMs: 420,
      purpose: 'translation',
      outcome: 'success',
      usageAvailability: 'reported',
      statusCode: 200,
    };
    const events = [
      {...base, id: 'ui-kimi-today', startedAt: now - 1000, serviceId: 'moonshot', configuredModel: 'kimi-k2.6', actualModel: 'kimi-k2.6', model: 'kimi-k2.6', inputTokens: 120, outputTokens: 80, totalTokens: 200, cachedInputTokens: 20},
      {...base, id: 'ui-kimi-yesterday', startedAt: localDay(1), serviceId: 'moonshot', configuredModel: 'kimi-k2.6', actualModel: 'kimi-k2.6', model: 'kimi-k2.6', inputTokens: 180, outputTokens: 120, totalTokens: 300},
      {...base, id: 'ui-openai-five-days', startedAt: localDay(5), serviceId: 'openai', configuredModel: 'gpt-5.6-luna', actualModel: 'gpt-5.6-luna', model: 'gpt-5.6-luna', inputTokens: 100, outputTokens: 50, totalTokens: 150},
      {...base, id: 'ui-kimi-ten-days', startedAt: localDay(10), serviceId: 'moonshot', configuredModel: 'kimi-k3', actualModel: 'kimi-k3', model: 'kimi-k3', inputTokens: 420, outputTokens: 180, totalTokens: 600},
      {...base, id: 'ui-kimi-unreported', startedAt: now - 500, serviceId: 'moonshot', configuredModel: 'kimi-k2.6', actualModel: 'kimi-k2.6', model: 'kimi-k2.6', usageAvailability: 'unreported'},
      {...base, id: 'ui-deepseek-error', startedAt: now - 250, serviceId: 'deepseek', configuredModel: 'deepseek-chat', actualModel: 'deepseek-chat', model: 'deepseek-chat', outcome: 'error', usageAvailability: 'unreported', statusCode: 429},
    ];

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('FluentReadModelUsage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('events')) throw new Error('模型用量 events 表未创建');
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('events', 'readwrite');
        const store = transaction.objectStore('events');
        store.clear();
        for (const event of events) store.put(event);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
    return {
      eventCount: events.length,
      allTokens: 1250,
      kimiTokens: 1100,
      kimiK2Tokens: 500,
      todayKimiTokens: 200,
      // 缓存构成只对服务商确实返回 cachedInputTokens 的请求计算；当前 fixture
      // 唯一可计算请求为 120 输入（其中 20 缓存读取）与 80 输出。
      allAverageUncachedInput: 100,
      allAverageCachedInput: 20,
      allAverageOutput: 80,
      todayKimiAverageUncachedInput: 100,
      todayKimiAverageCachedInput: 20,
      todayKimiAverageOutput: 80,
    };
  });
}

async function seedVocabularyBackupFixture(page) {
  return page.evaluate(async () => {
    const privateContext = {
      text: 'private vocabulary context sentinel',
      sourceUrl: 'https://private-vocabulary-context.invalid/article',
      pageTitle: 'Private vocabulary context title sentinel',
    };
    const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!stored?.success || !stored.value || typeof stored.value !== 'object') {
      throw new Error(stored?.error || '读取单词本 Beta 配置基线失败');
    }
    const previousBetaEnabled = stored.value.vocabularyBookEnabled === true;
    const enabled = await chrome.runtime.sendMessage({
      type: 'persistConfig',
      mode: 'patch',
      config: {vocabularyBookEnabled: true},
      expected: {vocabularyBookEnabled: previousBetaEnabled},
      clientId: 'settings-browser-vocabulary-backup-fixture',
      sequence: 1,
    });
    if (!enabled?.success) throw new Error(enabled?.error || '开启单词本 Beta 测试基线失败');
    const clearResponse = await chrome.runtime.sendMessage({
      type: 'fluentReadVocabularyBook',
      action: 'clear',
    });
    if (!clearResponse?.success) {
      throw new Error(clearResponse?.error?.message || '清空单词本测试基线失败');
    }
    const response = await chrome.runtime.sendMessage({
      type: 'fluentReadVocabularyBook',
      action: 'upsert',
      input: {
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
        term: 'backup-contract-sentinel',
        translation: '备份契约测试',
        context: {...privateContext, capturedAt: Date.now()},
      },
    });
    if (!response?.success || !response.data?.id) {
      throw new Error(response?.error?.message || '建立单词本备份测试基线失败');
    }
    return {
      entryId: response.data.id,
      term: 'backup-contract-sentinel',
      privateContext,
    };
  });
}

async function appendModelUsageRefreshEvent(page) {
  return page.evaluate(async () => {
    const event = {
      schemaVersion: 1,
      id: 'ui-return-refresh',
      startedAt: Date.now() - 100,
      durationMs: 360,
      serviceId: 'openai',
      configuredModel: 'gpt-5.6-luna',
      actualModel: 'gpt-5.6-luna',
      model: 'gpt-5.6-luna',
      purpose: 'translation',
      outcome: 'success',
      usageAvailability: 'reported',
      statusCode: 200,
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('FluentReadModelUsage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('events', 'readwrite');
        transaction.objectStore('events').put(event);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
    return {deltaTokens: event.totalTokens};
  });
}

async function chooseDifferentSelectOption(page, inputSelector) {
  const input = page.locator(inputSelector);
  await input.waitFor({state: 'visible', timeout});
  const wrapper = input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]');
  const selectedLabel = wrapper.locator('.el-select__placeholder');
  const before = (await selectedLabel.textContent())?.trim();
  await wrapper.click();
  const options = page.locator('.el-select-dropdown:visible .el-select-dropdown__item:not(.is-disabled)');
  await options.first().waitFor({state: 'visible', timeout});
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    if ((await option.textContent())?.trim() !== before) {
      await option.click();
      await page.waitForFunction(
        ({selector, previous}) => document.querySelector(selector)
          ?.closest('.el-select__wrapper')
          ?.querySelector('.el-select__placeholder')
          ?.textContent?.trim() !== previous,
        {selector: inputSelector, previous: before},
        {timeout},
      );
      const after = (await selectedLabel.textContent())?.trim();
      if (after === before) throw new Error(`${inputSelector} 未切换到其他选项`);
      return {before, after};
    }
  }
  throw new Error(`${inputSelector} 没有可切换的选项`);
}

async function selectElementPlusOption(page, ariaLabel, optionText) {
  const input = page.locator(`input[aria-label="${ariaLabel}"]`);
  await input.waitFor({state: 'visible', timeout});
  const wrapper = input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]');
  const previouslyOpenDropdown = page.locator('.el-select-dropdown:visible').first();
  if (await previouslyOpenDropdown.isVisible()) {
    await page.keyboard.press('Escape');
    await previouslyOpenDropdown.waitFor({state: 'hidden', timeout});
  }
  await wrapper.click();
  const openDropdown = page.locator('.el-select-dropdown:visible').first();
  await page.waitForTimeout(50);
  if (!await openDropdown.isVisible()) await input.press('ArrowDown');
  await openDropdown.waitFor({state: 'visible', timeout});
  const option = openDropdown.getByRole('option', {name: optionText, exact: true});
  await option.waitFor({state: 'visible', timeout});
  await option.evaluate(element => element.click());
  try {
    await page.waitForFunction(({label, expected}) => {
      const inputElement = [...document.querySelectorAll('input[aria-label]')]
        .find(element => element.getAttribute('aria-label') === label);
      const selectWrapper = inputElement?.closest('.el-select__wrapper');
      const displayed = selectWrapper?.querySelector('.el-select__selected-item, .el-select__placeholder');
      return displayed?.textContent?.trim() === expected
        || selectWrapper?.textContent?.trim() === expected;
    }, {label: ariaLabel, expected: optionText}, {timeout});
  } catch (error) {
    const state = await wrapper.evaluate(element => ({
      text: element.textContent?.trim(),
      html: element.innerHTML,
      inputs: [...element.querySelectorAll('input')].map(input => ({
        value: input.value,
        ariaLabel: input.getAttribute('aria-label'),
      })),
    }));
    throw new Error(`${ariaLabel} 选择后状态异常：${JSON.stringify(state)}；${error instanceof Error ? error.message : String(error)}`);
  }
  await page.keyboard.press('Escape');
  await page.locator('.el-select-dropdown:visible').waitFor({state: 'hidden', timeout});
}

function assertExportContainsAllUserConfiguration(value) {
  const credentialFields = [
    'token', 'ak', 'sk', 'appid', 'key', 'youdaoAppKey', 'youdaoAppSecret',
    'tencentSecretId', 'tencentSecretKey', 'extra',
  ];
  for (const field of credentialFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`完整备份配置缺少专用凭据字段：${field}`);
    }
  }
  for (const field of ['system_role', 'user_role', 'model', 'customModel', 'customBody', 'proxy']) {
    if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) {
      throw new Error(`完整备份配置缺少完整用户映射：${field}`);
    }
  }
  for (const field of ['count', 'persistCredentials', '__fluentConfigRevision', '__fluentCountOperations']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`完整备份配置包含不可迁移运行字段：${field}`);
    }
  }
}

function assertImportedSentinels(value, sentinels) {
  const expected = {
    token: value.token?.openai,
    ak: value.ak,
    sk: value.sk,
    appid: value.appid,
    key: value.key,
    youdaoAppKey: value.youdaoAppKey,
    youdaoAppSecret: value.youdaoAppSecret,
    tencentSecretId: value.tencentSecretId,
    tencentSecretKey: value.tencentSecretKey,
    extra: value.extra?.indexedDbProof,
    userRole: value.user_role?.openai,
    systemRole: value.system_role?.openai,
    proxy: value.proxy?.openai,
    customBody: value.customBody?.openai,
  };
  for (const [field, sentinel] of Object.entries(sentinels)) {
    if (expected[field] !== sentinel) {
      throw new Error(`重载后的完整备份未保留 ${field}：${JSON.stringify(expected[field])}`);
    }
  }
}

function assertCompleteBackupEnvelope(value, sentinels, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('下载内容不是完整备份 JSON 对象');
  }
  if (value.format !== 'fluentread-data-backup'
    || value.version !== 2
    || value.configCredentialMode !== 'exact-replace'
    || !Number.isFinite(value.exportedAt)) {
    throw new Error(`完整备份顶层信封异常：${JSON.stringify({
      format: value.format,
      version: value.version,
      configCredentialMode: value.configCredentialMode,
      exportedAt: value.exportedAt,
    })}`);
  }
  assertExportContainsAllUserConfiguration(value.config);
  assertImportedSentinels(value.config, sentinels);
  if (value.vocabulary?.format !== 'fluentread-vocabulary-book'
    || value.vocabulary?.version !== 1
    || !Number.isFinite(value.vocabulary?.exportedAt)
    || typeof value.vocabulary?.includesPrivateContext !== 'boolean'
    || !Array.isArray(value.vocabulary?.entries)
    || !Array.isArray(value.vocabulary?.reviewLogs)) {
    throw new Error('完整备份中的单词本信封异常');
  }
  if (value.modelUsage?.format !== 'fluentread-model-usage'
    || value.modelUsage?.version !== 1
    || !Number.isFinite(value.modelUsage?.exportedAt)
    || !Array.isArray(value.modelUsage?.events)) {
    throw new Error('完整备份中的模型用量信封异常');
  }
  if (Number.isInteger(options.minimumVocabularyEntries)
    && value.vocabulary.entries.length < options.minimumVocabularyEntries) {
    throw new Error(`完整备份丢失单词本记录：${value.vocabulary.entries.length}`);
  }
  if (Number.isInteger(options.minimumModelUsageEvents)
    && value.modelUsage.events.length < options.minimumModelUsageEvents) {
    throw new Error(`完整备份丢失模型用量记录：${value.modelUsage.events.length}`);
  }
  if (options.expectPrivateContext === false) {
    if (value.vocabulary.includesPrivateContext !== false) {
      throw new Error('选择“不包含并导出”后备份仍标记为包含单词上下文');
    }
    const serializedVocabulary = JSON.stringify(value.vocabulary);
    for (const sentinel of Object.values(options.privateContextSentinels || {})) {
      if (serializedVocabulary.includes(sentinel)) {
        throw new Error(`安全导出的单词本泄露上下文：${sentinel}`);
      }
    }
  }
}

async function downloadCompleteBackup(page, includePrivateContext = false) {
  const downloadPromise = page.waitForEvent('download', {timeout});
  await page.getByRole('button', {name: '导出备份', exact: true}).click();
  const contextDialog = page.locator('.el-message-box:visible');
  await contextDialog.getByText('是否包含单词上下文？', {exact: true}).waitFor({state: 'visible', timeout});
  for (const label of ['不包含并导出', '包含并导出']) {
    await contextDialog.getByRole('button', {name: label, exact: true}).waitFor({state: 'visible', timeout});
  }
  await contextDialog.getByRole('button', {
    name: includePrivateContext ? '包含并导出' : '不包含并导出',
    exact: true,
  }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('完整备份下载未产生可读文件');
  const suggestedFilename = download.suggestedFilename();
  if (!/^fluentread-backup-\d{4}-\d{2}-\d{2}\.json$/.test(suggestedFilename)) {
    throw new Error(`完整备份文件名异常：${suggestedFilename}`);
  }
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(downloadedPath, 'utf8'));
  } catch (error) {
    throw new Error(`完整备份下载内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return {backup, suggestedFilename};
}

async function inspectEncryptedConfigurationStorage(page, sentinels, expectedRecordKeys = expectedEncryptedRecordKeys) {
  const snapshot = await page.evaluate(async ({databaseName}) => {
    const requestResult = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
    });
    const database = await requestResult(indexedDB.open(databaseName));
    let records;
    try {
      const transaction = database.transaction('records', 'readonly');
      records = await requestResult(transaction.objectStore('records').getAll());
    } finally {
      database.close();
    }
    const local = await chrome.storage.local.get(null);
    let session = {};
    let sessionSupported = true;
    try {
      session = await chrome.storage.session.get(null);
    } catch {
      sessionSupported = false;
    }
    return {records, local, session, sessionSupported};
  }, {databaseName: configDatabaseName});

  const rawRecords = JSON.stringify(snapshot.records);
  for (const sentinel of Object.values(sentinels)) {
    if (rawRecords.includes(sentinel)) throw new Error(`IndexedDB 原始记录泄露明文：${sentinel}`);
  }
  const recordKeys = snapshot.records.map(record => record.key).sort();
  for (const key of expectedRecordKeys) {
    if (!recordKeys.includes(key)) throw new Error(`加密配置数据库缺少记录：${key}`);
  }
  if (recordKeys.includes('session:credentials')) {
    throw new Error('旧 session:credentials 迁移后仍残留在加密配置数据库');
  }
  for (const record of snapshot.records) {
    const payload = record?.payload;
    if (payload?.format !== 'fluentread-config'
      || payload?.version !== 1
      || payload?.algorithm !== 'AES-GCM'
      || typeof payload?.iv !== 'string'
      || typeof payload?.ciphertext !== 'string'
      || 'value' in record) {
      throw new Error(`IndexedDB 配置记录不是受支持的密文 envelope：${record?.key}`);
    }
  }
  const localKeys = Object.keys(snapshot.local).sort();
  const sessionKeys = Object.keys(snapshot.session).sort();
  const retainedLegacyLocal = legacyLocalStorageKeys.filter(key => localKeys.includes(key));
  const retainedLegacySession = legacySessionStorageKeys.filter(key => sessionKeys.includes(key));
  if (retainedLegacyLocal.length || retainedLegacySession.length) {
    throw new Error(`旧配置键未清理：${JSON.stringify({retainedLegacyLocal, retainedLegacySession})}`);
  }
  const sessionMaterialKeys = sessionKeys.filter(key => (
    key === 'configIndexedDbKeyMaterial' || key === 'session:configIndexedDbKeyMaterial'
  ));
  // 升级旧 session 凭据时可能短暂生成一份随机会话材料；Chrome 也可能在
  // runtime.reload 时直接清除它。它不是凭据权威记录，因此只禁止重复残留，
  // 不把“必须存在”或“必须不存在”当成持久化正确性的前提。
  if (sessionMaterialKeys.length > 1) {
    throw new Error(`会话密钥材料出现重复别名：${JSON.stringify(sessionKeys)}`);
  }
  return {
    databaseName: configDatabaseName,
    recordKeys,
    encryptedEnvelopeCount: snapshot.records.length,
    localStorageKeys: localKeys,
    sessionStorageKeys: sessionKeys,
    sessionMaterialKeys,
    plaintextSentinelsAbsent: true,
    legacyKeysAbsent: true,
  };
}

async function seedLegacyStorageAndReloadExtension(page, context, extensionOrigin, timeout) {
  const legacySources = await page.evaluate(async ({databaseName, sentinels}) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('删除配置数据库失败'));
      request.onblocked = () => reject(new Error('配置数据库仍被旧后台连接占用'));
    });

    const localKeys = [
      'config', 'local:config',
      'configHistory', 'local:configHistory',
      'configAutoBackups', 'local:configAutoBackups',
      'credentials', 'local:credentials',
      'fluentReadImageOcrLanguages', 'local:fluentReadImageOcrLanguages',
    ];
    const sessionKeys = [
      'credentials', 'session:credentials',
      'configIndexedDbKeyMaterial', 'session:configIndexedDbKeyMaterial',
    ];
    await chrome.storage.local.remove(localKeys);
    await chrome.storage.session.remove(sessionKeys);
    await chrome.storage.local.set({
      config: JSON.stringify({
        on: true,
        service: 'freeTranslation',
        display: 1,
        from: 'auto',
        to: 'zh-Hans',
        uiLanguage: 'zh-CN',
        uiLanguageSetupCompleted: true,
        persistCredentials: true,
        token: {openai: 'legacy-embedded-token-must-lose-precedence'},
        appid: 'legacy-embedded-appid-must-lose-precedence',
        key: 'legacy-embedded-key-must-lose-precedence',
        user_role: {openai: sentinels.userRole},
        system_role: {openai: sentinels.systemRole},
      }),
      credentials: {
        token: {openai: sentinels.token},
        appid: sentinels.appid,
        key: sentinels.key,
      },
    });
    const localBeforeReload = await chrome.storage.local.get(null);
    const sessionBeforeReload = await chrome.storage.session.get(null);
    setTimeout(() => chrome.runtime.reload(), 50);
    return {
      localKeys: Object.keys(localBeforeReload).sort(),
      sessionKeys: Object.keys(sessionBeforeReload).sort(),
      configStoredAsJsonString: typeof localBeforeReload.config === 'string',
    };
  }, {databaseName: configDatabaseName, sentinels: legacyMigrationSentinels});

  await new Promise(resolve => setTimeout(resolve, 750));
  if (!page.isClosed()) await page.close().catch(() => undefined);
  let migratedPage;
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    migratedPage = await newPageWithoutForeground(context, timeout);
    try {
      await migratedPage.goto(`${extensionOrigin}/options.html#settings-general`, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      await migratedPage.locator('.settings-app').waitFor({state: 'visible', timeout});
      return {page: migratedPage, legacySources};
    } catch (error) {
      lastError = error;
      await migratedPage.close().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`扩展重载后设置页不可用：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function verifyIndependentAreaSettings(page, context, extensionOrigin, report, attachPageDiagnostics) {
  await page.locator('button[data-section="settings-area-translation"]').click();
  const readChoice = label => page.locator(`input[aria-label="${label}"]`).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]').locator('.el-select__placeholder').textContent();
  const before = {
    enabled: await page.getByRole('switch', {name: '启用圈选翻译', exact: true}).getAttribute('aria-checked'),
    service: (await readChoice('圈选翻译服务'))?.trim(),
    mode: (await readChoice('翻译方式'))?.trim(),
    sourceLanguage: (await readChoice('识别语言'))?.trim(),
  };
  if (before.enabled !== 'true') await page.getByRole('switch', {name: '启用圈选翻译', exact: true}).locator('..').click();
  await selectElementPlusOption(page, '圈选翻译服务', '微软翻译');
  await selectElementPlusOption(page, '翻译方式', '标准翻译');
  const modeInput = page.locator('input[aria-label="翻译方式"]');
  await modeInput.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]').click();
  await page.locator('.el-select-dropdown:visible').getByRole('option', {name: 'AI 上下文增强', exact: true}).waitFor({state: 'visible', timeout});
  const aiDisabled = await page.locator('.el-select-dropdown:visible').getByRole('option', {name: 'AI 上下文增强', exact: true}).getAttribute('aria-disabled');
  if (aiDisabled !== 'true') throw new Error('微软翻译未禁用不支持的 AI 上下文增强选项');
  await page.keyboard.press('Escape');
  await selectElementPlusOption(page, '圈选翻译服务', 'OpenAI');
  await selectElementPlusOption(page, '翻译方式', 'AI 上下文增强');
  await selectElementPlusOption(page, '识别语言', '繁體中文');
  const reopenedUrl = page.url();
  await page.close();
  page = await newPageWithoutForeground(context, timeout);
  attachPageDiagnostics(page);
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto(reopenedUrl, {waitUntil: 'domcontentloaded', timeout});
  await page.locator('#settings-area-translation').waitFor({state: 'visible', timeout});
  const after = {
    enabled: await page.getByRole('switch', {name: '启用圈选翻译', exact: true}).getAttribute('aria-checked'),
    service: (await readChoice('圈选翻译服务'))?.trim(),
    mode: (await readChoice('翻译方式'))?.trim(),
    sourceLanguage: (await readChoice('识别语言'))?.trim(),
  };
  if (JSON.stringify(after) !== JSON.stringify({enabled: 'true', service: 'OpenAI', mode: 'AI 上下文增强', sourceLanguage: '繁體中文'})) {
    throw new Error(`圈选设置快速关闭后丢失：${JSON.stringify({before, after})}`);
  }
  report.persistenceCases.push({case: 'independent-area-options-quick-close', before, after, closedImmediatelyAfterChange: true});
  report.screenshots.push(await screenshot(page, 'settings-area-reopened-persisted.png'));
  const popup = await newPageWithoutForeground(context, timeout);
  attachPageDiagnostics(popup);
  await popup.setViewportSize({width: 400, height: 600});
  await popup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
  await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
  const ids = await popup.locator('[data-popup-quick-feature]').evaluateAll(elements => elements.map(element => element.getAttribute('data-popup-quick-feature')));
  if (ids.length !== 6 || new Set(ids).size !== 6 || !ids.includes('area') || ids.includes('appearance')) throw new Error(`Popup 独立圈选卡异常：${JSON.stringify(ids)}`);
  await popup.locator('[data-popup-quick-feature="area"]').click();
  const areaDrawer = popup.locator('.drawer-surface');
  await areaDrawer.getByRole('heading', {name: '圈选翻译设置', exact: true}).waitFor({state: 'visible', timeout});
  if (await areaDrawer.getByRole('switch', {name: '启用或关闭圈选翻译'}).getAttribute('aria-checked') !== 'true') throw new Error('Popup 没有同步圈选开关');
  if (!(await areaDrawer.innerText()).includes('AI 不查看截图')) throw new Error('Popup 缺少 AI 圈选能力边界说明');
  report.screenshots.push(await screenshot(popup, 'popup-area-independent-drawer.png'));
  await areaDrawer.getByRole('button', {name: '关闭', exact: true}).click();
  await popup.locator('[data-popup-quick-feature="image"]').click();
  await areaDrawer.getByRole('heading', {name: '图片翻译设置', exact: true}).waitFor({state: 'visible', timeout});
  if (await areaDrawer.getByRole('switch', {name: '启用或关闭圈选翻译'}).count()) throw new Error('图片抽屉混入圈选开关');
  report.screenshots.push(await screenshot(popup, 'popup-image-independent-drawer.png'));
  const imageOptionsCreated = context.waitForEvent('page', {timeout});
  await areaDrawer.locator('.drawer-settings-link').click();
  const imageOptionsPage = await imageOptionsCreated;
  attachPageDiagnostics(imageOptionsPage);
  await imageOptionsPage.waitForURL(`${extensionOrigin}/options.html#settings-image-translation`, {timeout});
  await imageOptionsPage.locator('#settings-image-translation').waitFor({state: 'visible', timeout});
  await imageOptionsPage.close();
  if (!popup.isClosed()) await popup.close();
  const areaLinkPopup = await newPageWithoutForeground(context, timeout);
  attachPageDiagnostics(areaLinkPopup);
  await areaLinkPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
  await areaLinkPopup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout});
  await areaLinkPopup.locator('[data-popup-quick-feature="area"]').click();
  const areaOptionsCreated = context.waitForEvent('page', {timeout});
  await areaLinkPopup.locator('.drawer-settings-link').click();
  const areaOptionsPage = await areaOptionsCreated;
  attachPageDiagnostics(areaOptionsPage);
  await areaOptionsPage.waitForURL(`${extensionOrigin}/options.html#settings-area-translation`, {timeout});
  await areaOptionsPage.locator('#settings-area-translation').waitFor({state: 'visible', timeout});
  await areaOptionsPage.close();
  if (!areaLinkPopup.isClosed()) await areaLinkPopup.close();
  report.assertions.independentImageAndAreaSettingsLinks = true;
  report.crossPageSync.areaOptionsToPopup = true;
  report.areaTranslationUi = {standardMachineSupported: true, unsupportedAiDisabled: true, aiModeSaved: true, cardIds: ids, responsive: []};
  for (const width of [1440, 1024, 820, 390]) {
    await page.setViewportSize({width, height: 900});
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
      await settleFiniteUiAnimations(page);
      const metrics = await page.locator('#settings-area-translation').evaluate(element => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        controlsWithinViewport: [...element.querySelectorAll('.el-select, .el-switch')].every(control => {
          const box = control.getBoundingClientRect();
          return box.left >= -1 && box.right <= innerWidth + 1;
        }),
        ocrCardBackground: getComputedStyle(element.querySelector('.image-ocr-pack-card')).backgroundColor,
        ocrTitleColor: getComputedStyle(element.querySelector('.image-ocr-heading h2')).color,
        duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, index, list) => list.indexOf(id) !== index),
      }));
      if (metrics.horizontalOverflow || !metrics.controlsWithinViewport || metrics.duplicateIds.length) throw new Error(`圈选 ${width}px ${dark ? 'dark' : 'light'} 布局异常：${JSON.stringify(metrics)}`);
      const backgroundChannels = parseCssColor(metrics.ocrCardBackground);
      const titleChannels = parseCssColor(metrics.ocrTitleColor);
      if (!backgroundChannels || !titleChannels
        || (dark && backgroundChannels.reduce((sum, channel) => sum + channel, 0) / 3 >= 90)
        || contrastRatio(metrics.ocrTitleColor, metrics.ocrCardBackground) < 4.5) {
        throw new Error(`共享 OCR ${dark ? 'dark' : 'light'} 主题不可读：${JSON.stringify(metrics)}`);
      }
      report.areaTranslationUi.responsive.push({width, dark, ...metrics});
      report.screenshots.push(await screenshot(page, `settings-area-${width}-${dark ? 'dark' : 'light'}.png`));
    }
  }
  await page.setViewportSize({width: 1440, height: 1000});
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await selectElementPlusOption(page, '圈选翻译服务', before.service);
  await selectElementPlusOption(page, '翻译方式', before.mode);
  await selectElementPlusOption(page, '识别语言', before.sourceLanguage);
  if (before.enabled !== 'true') await page.getByRole('switch', {name: '启用圈选翻译', exact: true}).locator('..').click();
  await assertTestBrowserRemainsBackground(context, '独立圈选设置验证完成');
  return page;
}

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-settings-center-profile-'));
  const errors = [];
  const report = {
    ok: false,
    extensionDir,
    artifactsDir,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    navigation: [],
    responsive: [],
    defaultServiceCard: {responsive: []},
    bilingualHighlightPreview: null,
    translationLoadingStyles: {},
    informationArchitecture: {},
    persistenceCases: [],
    quickClose: {},
    crossPageSync: {},
    latestWriteWins: {},
    assertions: {},
    consoleErrors: errors,
    screenshots: [],
  };
  let launched;
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
    let workers = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension://'));
    if (workers.length === 0) workers = [await context.waitForEvent('serviceworker', {timeout})];
    const extensionId = new URL(workers[0].url()).host;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const attachPageDiagnostics = targetPage => {
      targetPage.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
      targetPage.on('console', message => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
      });
    };
    let page = await newPageWithoutForeground(context, timeout);
    attachPageDiagnostics(page);
    await page.goto(`${extensionOrigin}/options.html#settings-general`, {waitUntil: 'domcontentloaded', timeout});
    await page.locator('.settings-app').waitFor({state: 'visible', timeout});
    await page.setViewportSize({width: 1440, height: 1000});

    const migration = await seedLegacyStorageAndReloadExtension(page, context, extensionOrigin, timeout);
    page = migration.page;
    attachPageDiagnostics(page);
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('button[data-section="settings-data"]').click();
    await page.getByRole('heading', {name: '最近修改', exact: true}).waitFor({state: 'visible', timeout});
    await page.getByRole('heading', {name: '自动设置快照', exact: true}).waitFor({state: 'visible', timeout});
    const migratedRecordKeys = ['local:config', 'local:configAutoBackups', 'local:credentials'];
    await page.waitForFunction(async ({databaseName, expectedKeys}) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const keys = await new Promise((resolve, reject) => {
          const request = database.transaction('records', 'readonly').objectStore('records').getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return expectedKeys.every(key => keys.includes(key));
      } finally {
        database.close();
      }
    }, {databaseName: configDatabaseName, expectedKeys: migratedRecordKeys}, {timeout});
    report.legacyMigration = {
      ...migration.legacySources,
      ...(await inspectEncryptedConfigurationStorage(page, legacyMigrationSentinels, migratedRecordKeys)),
      legacyPersistentCredentialsMigratedAfterExtensionReload: true,
      legacySessionRecordAbsent: true,
    };
    await page.locator('button[data-section="settings-general"]').click();

    const navButtons = page.locator('nav[aria-label="设置分类"] button');
    const navCount = await navButtons.count();
    if (navCount !== expectedNavigation.length) throw new Error(`导航数量异常：${navCount}`);
    const ids = await navButtons.evaluateAll(buttons => buttons.map(button => button.dataset.section));
    if (new Set(ids).size !== ids.length) throw new Error('导航 section id 重复');
    const navigationContract = await navButtons.evaluateAll(buttons => buttons.map(button => [
      button.dataset.section,
      button.querySelector('strong')?.textContent?.trim(),
    ]));
    if (JSON.stringify(navigationContract) !== JSON.stringify(expectedNavigation)) {
      throw new Error(`导航顺序或名称异常：${JSON.stringify(navigationContract)}`);
    }
    report.informationArchitecture.navigation = navigationContract;
    const navigationGroupContract = await page.locator('nav[aria-label="设置分类"] .nav-group').evaluateAll(groups => groups.map(group => [
      group.querySelector('.nav-group-label')?.textContent?.trim(),
      [...group.querySelectorAll('button[data-section]')].map(button => button.dataset.section),
    ]));
    if (JSON.stringify(navigationGroupContract) !== JSON.stringify(expectedNavigationGroups)) {
      throw new Error(`导航分组异常：${JSON.stringify(navigationGroupContract)}`);
    }
    report.informationArchitecture.navigationGroups = navigationGroupContract;

    for (let index = 0; index < navCount; index += 1) {
      const button = navButtons.nth(index);
      const id = await button.getAttribute('data-section');
      const label = (await button.locator('strong').textContent())?.trim();
      await button.click();
      const activeButtons = page.locator('nav[aria-label="设置分类"] button[aria-current="page"]');
      if (await activeButtons.count() !== 1 || await activeButtons.first().getAttribute('data-section') !== id) {
        throw new Error(`${id} 导航激活状态异常`);
      }
      const anchor = page.locator(`#${id}`);
      if (await anchor.count() !== 1 || !await anchor.isVisible()) throw new Error(`页面锚点不可见：${id}`);
      if (id === 'settings-image-translation' || id === 'settings-area-translation') {
        const expectedOcrTitle = id === 'settings-area-translation' ? 'area-ocr-pack-title' : 'image-ocr-pack-title';
        if (await anchor.locator(`#${expectedOcrTitle}`).count() !== 1
          || await page.locator('.image-ocr-pack-list').count() !== 1) {
          throw new Error(`${id} 未复用唯一的活动 OCR 语言包管理界面`);
        }
        if (id === 'settings-image-translation'
          && await anchor.getByRole('switch', {name: '启用圈选翻译', exact: true}).count() !== 0) {
          throw new Error('图片设置仍混有圈选开关');
        }
        if (id === 'settings-area-translation') {
          const areaCopy = await anchor.innerText();
          for (const expected of ['圈选翻译服务', '翻译方式', '识别语言', 'Shift + Z', '不上传截图']) {
            if (!areaCopy.includes(expected)) throw new Error(`圈选独立设置缺少产品信息：${expected}`);
          }
          report.assertions.independentAreaSettings = true;
        }
      }
      const visiblePageHeadings = await page.locator('.topbar h1:visible').count();
      if (visiblePageHeadings !== 1) throw new Error(`${id} 页面级标题数量异常：${visiblePageHeadings}`);
      if (await page.locator('.card-intro:visible').count() !== 0) throw new Error(`${id} 仍有重复 card intro`);
      const metrics = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (metrics.horizontalOverflow) throw new Error(`${id} 出现横向滚动：${JSON.stringify(metrics)}`);
      const file = `settings-${String(index + 1).padStart(2, '0')}-${id}.png`;
      report.screenshots.push(await screenshot(page, file));
      report.navigation.push({id, label, title: (await page.locator('.topbar h1').textContent())?.trim(), metrics});
    }
    page = await verifyIndependentAreaSettings(page, context, extensionOrigin, report, attachPageDiagnostics);
    report.assertions.navigation = true;
    report.assertions.singlePageIntro = true;
    report.assertions.noLegacyIntros = await page.locator('.video-settings-hero, .image-ocr-kicker, .site-rules-kicker').count() === 0;
    if (!report.assertions.noLegacyIntros) throw new Error('仍存在旧的重复介绍元素');

    const interfaceSearchCases = [];
    for (const query of ['界面布局', '菜单栏布局', '海盐', '樱花', '抹茶', 'Emoji']) {
      await page.locator('button[data-section="settings-general"]').click();
      await page.locator('.search-box input').fill(query);
      const interfaceResult = page.locator('.search-results button').filter({has: page.locator('strong', {hasText: /^界面布局$/u})});
      if (await interfaceResult.count() !== 1) throw new Error(`搜索“${query}”没有唯一的界面布局入口`);
      await interfaceResult.click();
      await page.locator('#settings-interface').waitFor({state: 'visible', timeout});
      if (await page.locator('.search-box input').inputValue() !== ''
        || await page.locator('.search-results').count() !== 0
        || await page.locator('button[data-section="settings-interface"]').getAttribute('aria-current') !== 'page') {
        throw new Error(`搜索“${query}”跳转后没有正确激活界面布局或清空查询`);
      }
      interfaceSearchCases.push({query, destination: 'settings-interface', clearedAfterNavigation: true});
    }
    await page.locator('.search-box input').fill('fluentread-no-such-interface-setting');
    await page.locator('.search-empty').waitFor({state: 'visible', timeout});
    await page.locator('.search-box input').fill('');
    const legacyNavigationCases = [];
    for (const [hash, destination] of [
      ['settings-interface', 'settings-interface'],
      ['settings-shortcuts', 'settings-translation'],
    ]) {
      await page.goto(`${extensionOrigin}/options.html#${hash}`, {waitUntil: 'domcontentloaded', timeout});
      await page.reload({waitUntil: 'domcontentloaded', timeout});
      await page.locator(`#${destination}`).waitFor({state: 'visible', timeout});
      if (await page.locator(`button[data-section="${destination}"]`).getAttribute('aria-current') !== 'page') {
        throw new Error(`旧设置链接 #${hash} 没有正确激活 ${destination}`);
      }
      legacyNavigationCases.push({hash, destination});
    }
    report.informationArchitecture.interfaceSearchCases = interfaceSearchCases;
    report.informationArchitecture.legacyNavigationCases = legacyNavigationCases;
    report.assertions.interfaceSearchAndLegacyNavigation = true;

    // 界面布局中的段落加载样式必须用真实运行时指示器预览，并经统一配置链路持久化。
    await page.locator('button[data-section="settings-interface"]').click();
    const loadingStyleGroup = page.locator('.settings-section:visible .settings-group').filter({hasText: '动画与加载效果'});
    await loadingStyleGroup.waitFor({state: 'visible', timeout});
    const loadingStyleCards = loadingStyleGroup.locator('.loading-style-option');
    const loadingStyleContract = await loadingStyleCards.evaluateAll(cards => cards.map(card => ({
      value: card.querySelector('input[type="radio"]')?.value,
      label: card.querySelector('.loading-style-copy strong')?.textContent?.trim(),
      description: card.querySelector('.loading-style-copy small')?.textContent?.trim(),
      previewStyle: card.querySelector('.fluent-read-loading')?.getAttribute('data-fr-loading-style'),
    })));
    if (JSON.stringify(loadingStyleContract.map(item => [item.value, item.label])) !== JSON.stringify(expectedLoadingStyles)
      || loadingStyleContract.some(item => item.previewStyle !== item.value || !item.description)) {
      throw new Error(`段落加载样式或真实预览契约异常：${JSON.stringify(loadingStyleContract)}`);
    }
    const loadingPreviewMetrics = await loadingStyleGroup.locator('.fluent-read-loading').evaluateAll(indicators => indicators.map(indicator => {
      const rect = indicator.getBoundingClientRect();
      const style = indicator.style;
      return {
        loadingStyle: indicator.getAttribute('data-fr-loading-style'),
        motion: indicator.getAttribute('data-fr-motion'),
        width: rect.width,
        height: rect.height,
        closedShadowRoot: indicator.shadowRoot === null,
        widthPriority: style.getPropertyPriority('width'),
        animationPriority: style.getPropertyPriority('animation'),
      };
    }));
    if (loadingPreviewMetrics.some(item => item.motion !== 'animated'
      || item.width !== 16
      || item.height !== 16
      || !item.closedShadowRoot
      || item.widthPriority !== 'important'
      || item.animationPriority !== 'important')) {
      throw new Error(`段落加载预览没有保持隔离尺寸或动画状态：${JSON.stringify(loadingPreviewMetrics)}`);
    }
    for (const [value] of expectedLoadingStyles) {
      const optionCard = loadingStyleCards.filter({has: page.locator(`input[value="${value}"]`)});
      await optionCard.click();
      await page.waitForFunction(selected => (
        document.querySelector(`.loading-style-option input[value="${selected}"]`)?.checked === true
      ), value, {timeout});
    }
    await page.waitForTimeout(500);
    const storedLoadingStyle = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return response?.value?.translationLoadingStyle;
    });
    if (storedLoadingStyle !== 'signal') {
      throw new Error(`段落加载样式没有持久化最终选择：${String(storedLoadingStyle)}`);
    }
    report.screenshots.push(await screenshot(page, 'settings-interface-loading-styles-animated.png'));

    const animationSwitch = loadingStyleGroup.locator('.settings-item').filter({hasText: '动画效果'}).locator('.el-switch');
    await animationSwitch.click();
    await page.waitForFunction(() => (
      document.querySelector('.loading-style-picker')?.getAttribute('aria-disabled') === 'true'
      && [...document.querySelectorAll('.loading-style-picker .fluent-read-loading')]
        .every(indicator => indicator.getAttribute('data-fr-motion') === 'static')
    ), undefined, {timeout});
    report.screenshots.push(await screenshot(page, 'settings-interface-loading-styles-static.png'));
    await animationSwitch.click();
    await loadingStyleCards.filter({has: page.locator('input[value="ring"]')}).click();
    await page.waitForTimeout(500);
    const restoredLoadingStyle = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return response?.value?.translationLoadingStyle;
    });
    if (restoredLoadingStyle !== 'ring') {
      throw new Error(`段落加载样式没有持久化恢复值：${String(restoredLoadingStyle)}`);
    }
    report.translationLoadingStyles = {
      options: loadingStyleContract,
      previewMetrics: loadingPreviewMetrics,
      persistedSelection: storedLoadingStyle,
      staticFallback: true,
      restoredSelection: restoredLoadingStyle,
    };
    report.assertions.translationLoadingStyles = true;

    // 基础配置中的界面布局统一容纳风格和菜单栏编排；默认风格保持原布局。
    // 设置页需要真实拖动并保存 Popup 模块顺序；Popup 重开后还要消费同一份布局与栏目配置。
    await page.locator('button[data-section="settings-interface"]').click();
    const interfaceSection = page.locator('#settings-interface');
    await interfaceSection.waitFor({state: 'visible', timeout});
    const interfaceSettingsGroup = page.locator('.settings-section:visible .settings-group').filter({hasText: '界面与弹窗'});
    const menuLayoutSettingsGroup = page.locator('.settings-section:visible .settings-group').filter({has: page.getByRole('heading', {name: '菜单栏布局', exact: true})});
    const interfaceGroups = (await interfaceSection.locator('.settings-group-heading h2').allTextContents()).map(value => value.trim());
    if (await interfaceSettingsGroup.count() !== 1 || await menuLayoutSettingsGroup.count() !== 1
      || JSON.stringify(interfaceGroups) !== JSON.stringify(expectedInterfaceGroups)) {
      throw new Error(`界面布局没有按顺序提供界面与弹窗、菜单栏布局两个分组：${JSON.stringify(interfaceGroups)}`);
    }
    if (/Popup\s*布局/iu.test(await interfaceSection.innerText())) {
      throw new Error('界面布局仍向用户显示 Popup 布局旧名称');
    }
    const expectedInterfaceSkins = [
      {value: 'default', label: '默认风格', kind: 'default', contentHeight: true, popupWidth: 400, brand: '#ef4776', surface: '#fff', darkSurface: '#1d2027'},
      {value: 'minimal', label: '简约风格', kind: 'minimal', contentHeight: true, popupWidth: 380, brand: '#ef4776', surface: '#fff', darkSurface: '#1d2027'},
      {value: 'compact', label: '紧凑风格', kind: 'compact', contentHeight: true, popupWidth: 360, brand: '#ef4776', surface: '#fff', darkSurface: '#1d2027'},
      {value: 'contrast', label: '高对比 ⚡', kind: 'contrast', contentHeight: true, popupWidth: 400, brand: '#111', surface: '#fff', darkSurface: '#050505'},
      {value: 'cheese', label: '奶酪 🧀', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#946d2f', surface: '#fffefa', darkSurface: '#28261f'},
      {value: 'ocean', label: '海盐 🌊', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#0676b7', surface: '#ffffff', darkSurface: '#102e40'},
      {value: 'matcha', label: '抹茶 🍵', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#327b28', surface: '#fffffc', darkSurface: '#22351d'},
      {value: 'sakura', label: '樱花 🌸', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#c83474', surface: '#fffefe', darkSurface: '#402335'},
      {value: 'emoji', label: 'Emoji 乐园 ✨', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#7143ca', surface: '#fffefd', darkSurface: '#382744'},
      {value: 'midnight', label: '夜幕 🌙', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#9eb5d0', surface: '#1d2632', darkSurface: '#1d2632'},
      {value: 'paper', label: '纸张护眼 📖', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#806b51', surface: '#fbf9f3', darkSurface: '#292620'},
      {value: 'aurora', label: '极光舷窗 🛰️', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#5147a8', surface: '#fcfbff', darkSurface: '#272544'},
      {value: 'arcade', label: '像素街机 🎮', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#087f65', surface: '#fbfffd', darkSurface: '#172f35'},
      {value: 'sunset', label: '落日公路 🛣️', kind: 'palette', contentHeight: true, popupWidth: 400, brand: '#b64f3b', surface: '#fffdfa', darkSurface: '#382b37'},
    ];
    const skinCards = interfaceSettingsGroup.locator('.interface-skin-option');
    if (await skinCards.count() !== expectedInterfaceSkins.length) {
      throw new Error(`弹窗风格选项数量异常：${await skinCards.count()}`);
    }
    const skinLabels = (await skinCards.locator('.interface-skin-copy strong').allTextContents()).map(value => value.trim());
    if (JSON.stringify(skinLabels) !== JSON.stringify(expectedInterfaceSkins.map(item => item.label))) {
      throw new Error(`弹窗风格名称或顺序异常：${JSON.stringify(skinLabels)}`);
    }
    if (await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="default"][aria-checked="true"]').count() !== 1) {
      throw new Error('默认风格没有保持当前界面选中状态');
    }
    const liveSkinPreview = interfaceSettingsGroup.locator('.interface-skin-live-preview');
    if (await liveSkinPreview.count() !== 1
      || await liveSkinPreview.getAttribute('data-preview-skin') !== 'default'
      || await interfaceSettingsGroup.getByText('风格只改变扩展界面的呈现，不影响网页翻译效果。', {exact: true}).count() !== 0) {
      throw new Error('弹窗风格没有用唯一的实时 DOM 范例替换静态说明');
    }
    const popupLayoutWorkbench = menuLayoutSettingsGroup.locator('[data-popup-layout-workbench]');
    const popupLayoutPreview = popupLayoutWorkbench.locator('.popup-layout-live-preview');
    const popupModuleTab = popupLayoutWorkbench.locator('[data-popup-layout-tab="popupModule"]');
    const popupQuickFeatureTab = popupLayoutWorkbench.locator('[data-popup-layout-tab="quickFeature"]');
    if (await popupLayoutWorkbench.count() !== 1
      || await popupLayoutPreview.count() !== 1
      || await popupModuleTab.getAttribute('aria-selected') !== 'true'
      || await popupQuickFeatureTab.getAttribute('aria-selected') !== 'false') {
      throw new Error('Popup 布局工作台没有呈现唯一实时范例或正确的默认标签页');
    }
    await popupModuleTab.focus();
    await popupModuleTab.press('ArrowRight');
    if (await popupQuickFeatureTab.getAttribute('aria-selected') !== 'true') {
      throw new Error('Popup 布局标签页方向键没有切换到快捷入口');
    }
    await popupQuickFeatureTab.press('ArrowLeft');
    if (await popupModuleTab.getAttribute('aria-selected') !== 'true') {
      throw new Error('Popup 布局标签页方向键没有切回整体区域');
    }
    const readPreviewLayoutOrder = () => popupLayoutPreview.locator('[data-preview-popup-module]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-preview-popup-module')),
    );
    const readPreviewQuickFeatureOrder = () => popupLayoutPreview.locator('[data-preview-quick-feature]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-preview-quick-feature')),
    );
    const popupLayoutEditor = menuLayoutSettingsGroup.locator('[data-popup-layout-editor]');
    if (await popupLayoutEditor.count() !== 1) throw new Error('菜单栏布局中没有唯一的布局编辑器');
    const readLayoutOrder = () => popupLayoutEditor.locator('[data-popup-layout-module]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-layout-module')),
    );
    const defaultLayoutOrder = ['translation', 'siteRule', 'quickFeatures', 'footer'];
    const customLayoutOrder = ['quickFeatures', 'translation', 'siteRule', 'footer'];
    const initialLayoutOrder = await readLayoutOrder();
    if (JSON.stringify(initialLayoutOrder) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`Popup 默认模块顺序异常：${JSON.stringify(initialLayoutOrder)}`);
    }
    if (JSON.stringify(await readPreviewLayoutOrder()) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`Popup 范例没有呈现默认模块顺序：${JSON.stringify(await readPreviewLayoutOrder())}`);
    }
    const hideButtons = popupLayoutEditor.locator('.popup-layout-hide');
    if (await hideButtons.count() !== 3) throw new Error(`弹窗栏目隐藏按钮数量异常：${await hideButtons.count()}`);
    if (await popupLayoutEditor.locator('.popup-layout-hidden-chip').count() !== 0) {
      throw new Error('默认弹窗栏目不应出现隐藏项目');
    }
    const popupQuickFeatureEditor = menuLayoutSettingsGroup.locator('[data-popup-quick-feature-editor]');
    if (await popupQuickFeatureEditor.count() !== 1) {
      throw new Error('菜单栏布局中没有唯一的快捷功能布局编辑器');
    }
    const readQuickFeatureOrder = () => popupQuickFeatureEditor.locator('[data-popup-quick-feature-layout]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-quick-feature-layout')),
    );
    const defaultSix = ['hover', 'selection', 'image', 'area', 'video', 'document'];
    if (JSON.stringify(await readQuickFeatureOrder()) !== JSON.stringify(defaultSix)) {
      throw new Error('快捷功能默认应显示六项并隐藏译文显示');
    }
    await popupQuickFeatureTab.click();
    await popupQuickFeatureEditor.getByRole('button', {name: '添加译文显示', exact: true}).click();
    await page.waitForFunction(() => !!document.querySelector('[data-popup-quick-feature-layout="appearance"]'));
    await popupModuleTab.click();
    // 后续继续覆盖用户显式添加七项后的排序、隐藏、主题与持久化。
    const defaultQuickFeatureOrder = ['hover', 'selection', 'appearance', 'image', 'area', 'video', 'document'];
    const customQuickFeatureOrder = ['document', 'hover', 'selection', 'appearance', 'image', 'area', 'video'];
    const visibleCustomQuickFeatureOrder = customQuickFeatureOrder.filter(feature => feature !== 'image');
    if (JSON.stringify(await readQuickFeatureOrder()) !== JSON.stringify(defaultQuickFeatureOrder)) {
      throw new Error(`快捷功能默认顺序异常：${JSON.stringify(await readQuickFeatureOrder())}`);
    }
    if (JSON.stringify(await readPreviewQuickFeatureOrder()) !== JSON.stringify(defaultQuickFeatureOrder)) {
      throw new Error(`Popup 范例没有呈现默认快捷功能顺序：${JSON.stringify(await readPreviewQuickFeatureOrder())}`);
    }
    if (await popupQuickFeatureEditor.locator('.popup-layout-hide').count() !== defaultQuickFeatureOrder.length) {
      throw new Error(`快捷功能隐藏按钮数量异常：${await popupQuickFeatureEditor.locator('.popup-layout-hide').count()}`);
    }
    if (await page.locator('html').getAttribute('data-interface-skin') !== 'default') {
      throw new Error('Options 初始弹窗风格不是默认风格');
    }
    report.screenshots.push(await screenshotElement(
      interfaceSettingsGroup.locator('.interface-skin-picker'),
      'settings-interface-skin-picker.png',
    ));

    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="minimal"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'minimal', undefined, {timeout});
    if (!await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="minimal"][aria-checked="true"]').isVisible()) {
      throw new Error('简约风格切换后没有进入选中状态');
    }

    const quickFeaturesHandle = popupLayoutEditor
      .locator('[data-popup-layout-module="quickFeatures"] .popup-layout-handle');
    const translationCard = popupLayoutEditor.locator('[data-popup-layout-module="translation"]');
    const siteRuleCard = popupLayoutEditor.locator('[data-popup-layout-module="siteRule"]');
    await quickFeaturesHandle.dragTo(translationCard, {targetPosition: {x: 40, y: 4}});
    const draggedLayoutOrder = await readLayoutOrder();
    if (JSON.stringify(draggedLayoutOrder) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 模块拖动没有更新顺序：${JSON.stringify(draggedLayoutOrder)}`);
    }
    if (JSON.stringify(await readPreviewLayoutOrder()) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 范例没有即时同步模块顺序：${JSON.stringify(await readPreviewLayoutOrder())}`);
    }

    // 真实鼠标拖动预览中的整块模块，确认预览本身就是可编辑入口。
    await dragWholeElement(
      page,
      popupLayoutPreview.locator('[data-preview-popup-module="quickFeatures"]'),
      popupLayoutPreview.locator('[data-preview-popup-module="siteRule"]'),
      'y',
      'after',
    );
    if (JSON.stringify(await readLayoutOrder()) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`预览整块模块拖动没有更新回默认顺序：${JSON.stringify(await readLayoutOrder())}`);
    }
    if (JSON.stringify(await readPreviewLayoutOrder()) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`预览整块模块拖动后的范例顺序异常：${JSON.stringify(await readPreviewLayoutOrder())}`);
    }
    await dragWholeElement(
      page,
      popupLayoutPreview.locator('[data-preview-popup-module="quickFeatures"]'),
      popupLayoutPreview.locator('[data-preview-popup-module="translation"]'),
      'y',
      'before',
    );
    if (JSON.stringify(await readLayoutOrder()) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`预览整块模块拖动没有再次更新顺序：${JSON.stringify(await readLayoutOrder())}`);
    }

    // 右侧编辑器允许拖动整张可见卡片，确保按钮区域不会成为唯一拖动入口。
    await dragWholeElement(
      page,
      popupLayoutEditor.locator('[data-popup-layout-module="quickFeatures"]'),
      siteRuleCard,
      'y',
      'after',
    );
    if (JSON.stringify(await readLayoutOrder()) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`右侧整卡拖动没有更新回默认顺序：${JSON.stringify(await readLayoutOrder())}`);
    }
    await dragWholeElement(
      page,
      popupLayoutEditor.locator('[data-popup-layout-module="quickFeatures"]'),
      translationCard,
      'y',
      'before',
    );
    if (JSON.stringify(await readLayoutOrder()) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`右侧整卡拖动没有再次更新顺序：${JSON.stringify(await readLayoutOrder())}`);
    }

    const previewTranslationHandle = popupLayoutPreview
      .locator('[data-preview-popup-module="translation"] > .layout-preview-drag-handle');
    await previewTranslationHandle.focus();
    await previewTranslationHandle.press('ArrowDown');
    if (JSON.stringify(await readPreviewLayoutOrder()) !== JSON.stringify(['quickFeatures', 'siteRule', 'translation', 'footer'])) {
      throw new Error(`预览模块键盘下移失败：${JSON.stringify(await readPreviewLayoutOrder())}`);
    }
    await previewTranslationHandle.press('ArrowUp');
    if (JSON.stringify(await readPreviewLayoutOrder()) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`预览模块键盘上移失败：${JSON.stringify(await readPreviewLayoutOrder())}`);
    }

    // 不额外等待就重载设置页，覆盖短生命周期页面中的最终布局保存。
    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await interfaceSection.waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'minimal', undefined, {timeout});
    const persistedLayoutOrder = await readLayoutOrder();
    if (JSON.stringify(persistedLayoutOrder) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 模块顺序在设置页重载后丢失：${JSON.stringify(persistedLayoutOrder)}`);
    }

    const translationHandle = popupLayoutEditor
      .locator('[data-popup-layout-module="translation"] .popup-layout-handle');
    await translationHandle.focus();
    await translationHandle.press('ArrowDown');
    const keyboardMovedOrder = await readLayoutOrder();
    const intermediateLayoutOrder = ['quickFeatures', 'siteRule', 'translation', 'footer'];
    if (JSON.stringify(keyboardMovedOrder) !== JSON.stringify(intermediateLayoutOrder)) {
      throw new Error(`Popup 模块键盘下移失败：${JSON.stringify(keyboardMovedOrder)}`);
    }
    await translationHandle.press('ArrowUp');
    if (JSON.stringify(await readLayoutOrder()) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 模块键盘上移失败：${JSON.stringify(await readLayoutOrder())}`);
    }
    // 连续两次修改后立即重载，最终顺序必须胜出，不能被较早快照覆盖。
    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await interfaceSection.waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'minimal', undefined, {timeout});
    const latestWriteLayoutOrder = await readLayoutOrder();
    if (JSON.stringify(latestWriteLayoutOrder) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 模块连续排序后没有保留最终值：${JSON.stringify(latestWriteLayoutOrder)}`);
    }
    await popupLayoutWorkbench.scrollIntoViewIfNeeded();
    report.screenshots.push(await screenshotElement(popupLayoutWorkbench, 'settings-popup-layout-workbench-custom.png'));

    await popupQuickFeatureTab.click();
    await popupQuickFeatureTab.waitFor({state: 'visible', timeout});
    if (await popupQuickFeatureTab.getAttribute('aria-selected') !== 'true') {
      throw new Error('快捷功能布局标签页没有进入选中状态');
    }
    const documentFeatureHandle = popupQuickFeatureEditor
      .locator('[data-popup-quick-feature-layout="document"] .popup-layout-handle');
    const hoverFeatureCard = popupQuickFeatureEditor.locator('[data-popup-quick-feature-layout="hover"]');
    await documentFeatureHandle.dragTo(hoverFeatureCard, {targetPosition: {x: 40, y: 4}});
    if (JSON.stringify(await readQuickFeatureOrder()) !== JSON.stringify(customQuickFeatureOrder)) {
      throw new Error(`快捷功能卡片拖动没有更新顺序：${JSON.stringify(await readQuickFeatureOrder())}`);
    }
    if (JSON.stringify(await readPreviewQuickFeatureOrder()) !== JSON.stringify(customQuickFeatureOrder)) {
      throw new Error(`Popup 范例没有即时同步快捷功能顺序：${JSON.stringify(await readPreviewQuickFeatureOrder())}`);
    }
    // 快捷入口在预览中横向排列，使用真实鼠标拖动一整张卡片覆盖 before/after 的水平几何判断。
    await dragWholeElement(
      page,
      popupLayoutPreview.locator('[data-preview-quick-feature="document"]'),
      popupLayoutPreview.locator('[data-preview-quick-feature="video"]'),
      'x',
      'after',
    );
    if (JSON.stringify(await readQuickFeatureOrder()) !== JSON.stringify(defaultQuickFeatureOrder)) {
      throw new Error(`预览整块快捷入口拖动没有更新回默认顺序：${JSON.stringify(await readQuickFeatureOrder())}`);
    }
    await dragWholeElement(
      page,
      popupLayoutPreview.locator('[data-preview-quick-feature="document"]'),
      popupLayoutPreview.locator('[data-preview-quick-feature="hover"]'),
      'x',
      'before',
    );
    if (JSON.stringify(await readQuickFeatureOrder()) !== JSON.stringify(customQuickFeatureOrder)) {
      throw new Error(`预览整块快捷入口拖动没有再次更新顺序：${JSON.stringify(await readQuickFeatureOrder())}`);
    }
    await popupQuickFeatureEditor.locator('[data-popup-quick-feature-layout="image"] .popup-layout-hide').click();
    if (await page.evaluate(() => document.activeElement?.classList.contains('popup-layout-handle'))) {
      throw new Error('鼠标隐藏入口不应强制移动焦点到其他卡片的手柄');
    }
    await page.waitForFunction(() => (
      document.querySelector('[data-popup-layout-workbench] [data-preview-quick-feature="image"]') === null
    ), undefined, {timeout});
    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await interfaceSection.waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'minimal', undefined, {timeout});
    await popupQuickFeatureTab.click();
    const persistedQuickFeatureOrder = await readQuickFeatureOrder();
    if (JSON.stringify(persistedQuickFeatureOrder) !== JSON.stringify(visibleCustomQuickFeatureOrder)
      || await popupQuickFeatureEditor.locator('[data-popup-quick-feature-layout="image"]').count() !== 0
      || await popupQuickFeatureEditor.locator('.popup-layout-hidden-chip').filter({hasText: '图片翻译'}).count() !== 1) {
      throw new Error(`快捷功能顺序或单项显隐在设置页重载后丢失：${JSON.stringify(persistedQuickFeatureOrder)}`);
    }
    await popupLayoutWorkbench.scrollIntoViewIfNeeded();
    report.screenshots.push(await screenshotElement(
      popupLayoutWorkbench,
      'settings-popup-layout-workbench-quick-features.png',
    ));

    await context.route('http://fluentread-interface.test/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><main>FluentRead interface fixture</main></body></html>',
    }));
    const interfaceHostPage = await newPageWithoutForeground(context, timeout);
    await interfaceHostPage.goto('http://fluentread-interface.test/article', {waitUntil: 'domcontentloaded', timeout});
    await activateExtensionTabWithoutForeground(context, interfaceHostPage, timeout);

    // 迁移基线已明确完成界面语言设置；先用真实 Popup 确认不会重新弹出引导，
    // 再验证每套皮肤，避免把尚未读取当前标签页的中间态误判成栏目缺失。
    const initializedPopup = await newPageWithoutForeground(context, timeout);
    attachPageDiagnostics(initializedPopup);
    await initializedPopup.setViewportSize({width: 400, height: 600});
    await initializedPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
    await initializedPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
    await initializedPopup.locator('.site-rule-row').waitFor({state: 'visible', timeout});
    if (await initializedPopup.getByTestId('ui-language-onboarding').count() !== 0) {
      throw new Error('已完成界面语言设置的迁移配置仍重复显示首次引导');
    }
    report.assertions.uiLanguageOnboardingCompletedBaseline = true;
    if (await initializedPopup.locator('.site-rule-row').count() !== 1) {
      throw new Error('简约风格没有在普通网页上下文显示当前网站栏目');
    }
    const popupModuleOrder = await initializedPopup.locator('[data-popup-module]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-module')),
    );
    if (JSON.stringify(popupModuleOrder) !== JSON.stringify(customLayoutOrder)) {
      throw new Error(`Popup 没有按保存布局渲染模块：${JSON.stringify(popupModuleOrder)}`);
    }
    const popupQuickFeatureOrder = await initializedPopup.locator('[data-popup-quick-feature]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-quick-feature')),
    );
    if (JSON.stringify(popupQuickFeatureOrder) !== JSON.stringify(visibleCustomQuickFeatureOrder)
      || await initializedPopup.locator('[data-popup-quick-feature="image"]').count() !== 0) {
      throw new Error(`Popup 没有应用快捷功能卡片的顺序与显隐：${JSON.stringify(popupQuickFeatureOrder)}`);
    }
    const reorderedModuleSpacing = await initializedPopup.evaluate(() => {
      const quickFeatures = document.querySelector('[data-popup-module="quickFeatures"]')?.getBoundingClientRect();
      const translation = document.querySelector('[data-popup-module="translation"]')?.getBoundingClientRect();
      const lastFeatureCard = document
        .querySelector('[data-popup-module="quickFeatures"] .feature-card:last-child')
        ?.getBoundingClientRect();
      const mainSwitch = document
        .querySelector('[data-popup-module="translation"] .hero-switches .switch')
        ?.getBoundingClientRect();
      return {
        moduleGap: quickFeatures && translation ? translation.top - quickFeatures.bottom : -1,
        controlGap: lastFeatureCard && mainSwitch ? mainSwitch.top - lastFeatureCard.bottom : -1,
      };
    });
    if (reorderedModuleSpacing.moduleGap < 10 || reorderedModuleSpacing.controlGap < 10) {
      throw new Error(`重排后快捷功能与网页翻译控件间距不足：${JSON.stringify(reorderedModuleSpacing)}`);
    }
    report.screenshots.push(await screenshotElement(
      initializedPopup.locator('.popup-shell'),
      'popup-interface-minimal-custom-layout.png',
    ));
    await initializedPopup.close();

    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="default"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'default', undefined, {timeout});
    await page.waitForTimeout(450);
    const defaultSingleFeatureHiddenPopup = await newPageWithoutForeground(context, timeout);
    attachPageDiagnostics(defaultSingleFeatureHiddenPopup);
    await defaultSingleFeatureHiddenPopup.setViewportSize({width: 400, height: 600});
    await defaultSingleFeatureHiddenPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
    await defaultSingleFeatureHiddenPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
    await defaultSingleFeatureHiddenPopup.waitForTimeout(300);
    const defaultSingleFeatureHiddenMetrics = await inspectPopupContentHeight(
      defaultSingleFeatureHiddenPopup, '默认风格隐藏单张快捷卡片',
    );
    if (defaultSingleFeatureHiddenMetrics.visibleQuickFeatures !== 6
      || await defaultSingleFeatureHiddenPopup.locator('[data-popup-quick-feature="image"]').count() !== 0) {
      throw new Error(`默认风格没有应用单张快捷卡片显隐：${JSON.stringify(defaultSingleFeatureHiddenMetrics)}`);
    }
    report.screenshots.push(await screenshotElement(
      defaultSingleFeatureHiddenPopup.locator('.popup-shell'),
      'popup-interface-default-single-feature-hidden.png',
    ));
    await defaultSingleFeatureHiddenPopup.close();

    // 先证明单项配置跨页面生效，再恢复七张卡片，避免影响后续完整皮肤矩阵。
    await popupQuickFeatureEditor.locator('.popup-layout-hidden-chip').filter({hasText: '图片翻译'}).getByRole('button', {name: '添加图片翻译', exact: true}).click();
    await popupQuickFeatureEditor.getByRole('button', {name: '恢复默认顺序'}).click();
    await page.waitForFunction((expected) => (
      JSON.stringify(
        [...document.querySelectorAll('[data-popup-quick-feature-editor] [data-popup-quick-feature-layout]')]
          .map(element => element.getAttribute('data-popup-quick-feature-layout')),
      ) === JSON.stringify(expected)
      && document.querySelector('[data-popup-quick-feature-editor] [data-popup-quick-feature-layout="image"]') !== null
      && document.querySelector('[data-popup-quick-feature-editor] .popup-layout-hidden-chip') === null
    ), defaultQuickFeatureOrder, {timeout});
    await page.waitForTimeout(500);

    const skinCases = [];
    // 矩阵较长：异常时也必须导出已完成的真实 case，避免只剩截图而丢失验证范围。
    report.informationArchitecture.interfaceSettings = {
      location: 'settings-interface',
      groups: interfaceGroups,
      skinOptions: expectedInterfaceSkins.map(item => item.value),
      skinCases,
    };
    const visualSignatures = new Set();
    // 皮肤矩阵复用同一真实扩展页，每次完整导航重新读取持久化配置。
    // 短生命周期关闭/重开由前面的独立 case 覆盖；避免反复创建 Target 使 macOS 激活 Edge。
    const skinPopup = await newPageWithoutForeground(context, timeout);
    attachPageDiagnostics(skinPopup);
    await skinPopup.setViewportSize({width: 400, height: 600});
    for (const skin of expectedInterfaceSkins) {
      const skinCard = interfaceSettingsGroup.locator(`.interface-skin-option[data-skin="${skin.value}"]`);
      await skinCard.click();
      await page.waitForFunction(({value, kind}) => (
        document.documentElement.dataset.interfaceSkin === value
        && document.documentElement.dataset.interfaceSkinKind === kind
        && document.querySelector('.interface-skin-live-preview')?.getAttribute('data-preview-skin') === value
      ), {value: skin.value, kind: skin.kind}, {timeout});
      if (await skinCard.getAttribute('aria-checked') !== 'true') {
        throw new Error(`${skin.label}切换后没有进入选中状态`);
      }
      const optionsMetrics = await page.evaluate(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          brand: rootStyle.getPropertyValue('--brand').trim(),
          workspaceBackground: getComputedStyle(document.querySelector('.workspace')).backgroundColor,
          sidebarBackground: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
          groupBackground: getComputedStyle(document.querySelector('#settings-interface .settings-group-body')).backgroundColor,
        };
      });
      if (optionsMetrics.horizontalOverflow
        || optionsMetrics.brand !== skin.brand
        || !optionsMetrics.workspaceBackground
        || !optionsMetrics.sidebarBackground
        || !optionsMetrics.groupBackground) {
        throw new Error(`${skin.label}设置页布局异常：${JSON.stringify(optionsMetrics)}`);
      }
      report.screenshots.push(await screenshotElement(skinCard, `settings-interface-${skin.value}.png`));
      report.screenshots.push(await screenshotElement(liveSkinPreview, `settings-interface-preview-${skin.value}.png`));
      const designMatrix = await verifyInterfaceDesignMatrix(page, skin, report);
      await page.waitForTimeout(320);

      await skinPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
      await skinPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
      await skinPopup.waitForTimeout(280);
      await skinPopup.evaluate(() => document.documentElement.classList.remove('dark'));
      await skinPopup.waitForTimeout(220);
      if (await skinPopup.locator(`main[data-interface-skin="${skin.value}"]`).count() !== 1) {
        throw new Error(`Popup 重新加载后没有应用${skin.label}`);
      }
      if (await skinPopup.locator('html').getAttribute('data-interface-skin-kind') !== skin.kind) {
        throw new Error(`${skin.label}没有应用注册的布局类型 ${skin.kind}`);
      }
      if (await skinPopup.locator('.site-rule-row').count() !== 1) {
        throw new Error(`${skin.label}没有在普通网页上下文显示当前网站栏目`);
      }
      const metrics = await skinPopup.locator('.popup-shell').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          shellHeight: rect.height,
          shellWidth: rect.width,
          heightMode: document.documentElement.dataset.popupHeight,
          popupWidthVariable: rootStyle.getPropertyValue('--interface-popup-width').trim(),
          htmlMinHeight: rootStyle.minHeight,
          bodyMinHeight: getComputedStyle(document.body).minHeight,
          appMinHeight: getComputedStyle(document.querySelector('#app')).minHeight,
          shellMinHeight: getComputedStyle(element).minHeight,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          brand: rootStyle.getPropertyValue('--brand').trim(),
          surface: rootStyle.getPropertyValue('--surface').trim(),
          ink: rootStyle.getPropertyValue('--ink').trim(),
          actionText: getComputedStyle(document.querySelector('.translate-button')).color,
          shellBackgroundImage: getComputedStyle(element).backgroundImage,
          heroRadius: getComputedStyle(document.querySelector('.hero-card')).borderRadius,
          visibleBetaBadges: [...document.querySelectorAll('.beta-badge')]
            .filter(badge => getComputedStyle(badge).display !== 'none').length,
          translateButtonBackground: getComputedStyle(document.querySelector('.translate-button')).backgroundColor,
          translateButtonBackgroundImage: getComputedStyle(document.querySelector('.translate-button')).backgroundImage,
          translateButtonShadow: getComputedStyle(document.querySelector('.translate-button')).boxShadow,
          heroSwitchBackground: getComputedStyle(document.querySelector('.hero-card .switch')).backgroundColor,
          heroSwitchKnobBackground: getComputedStyle(document.querySelector('.hero-card .switch i')).backgroundColor,
          brandIconFilter: getComputedStyle(document.querySelector('.popup-shell .brand img')).filter,
          brandIconOpacity: getComputedStyle(document.querySelector('.popup-shell .brand img')).opacity,
        };
      });
      metrics.textContrast = contrastRatio(metrics.ink, metrics.surface);
      metrics.motifs = await inspectInterfaceMotif(skinPopup.locator('.popup-shell'), skin);
      metrics.actionContrast = skin.kind === 'palette'
        ? contrastRatio(metrics.actionText, metrics.translateButtonBackground)
        : null;
      Object.assign(metrics, await inspectPopupContentHeight(skinPopup, `${skin.label}完整栏目`));
      if (Math.abs(metrics.shellWidth - skin.popupWidth) > 1
        || metrics.popupWidthVariable !== `${skin.popupWidth}px`
        || metrics.shellHeight > 560
        || metrics.horizontalOverflow
        || metrics.brand !== skin.brand
        || metrics.surface !== skin.surface
        || !metrics.ink
        || metrics.textContrast < 4.5
        || (skin.kind === 'palette' && (
          metrics.actionContrast < 4.5
          || JSON.stringify(parseCssColor(metrics.translateButtonBackground)) !== JSON.stringify(parseCssColor(metrics.brand))
          || metrics.translateButtonBackgroundImage !== 'none'
          || metrics.shellBackgroundImage === 'none'
        ))) {
        throw new Error(`${skin.label}基础布局异常：${JSON.stringify(metrics)}`);
      }
      if (skin.value === 'minimal' && (
        metrics.visibleBetaBadges !== 0
        || metrics.translateButtonBackgroundImage !== 'none'
        || metrics.translateButtonShadow !== 'none'
        || metrics.translateButtonBackground === 'rgb(239, 71, 118)'
        || metrics.heroSwitchBackground === 'rgb(239, 71, 118)'
        || metrics.brandIconFilter !== 'none'
        || metrics.brandIconOpacity !== '0.78'
      )) {
        throw new Error(`简约风格仍包含装饰标签或高强调控件：${JSON.stringify(metrics)}`);
      }
      if (skin.value === 'emoji') {
        metrics.emojiIcons = await skinPopup.locator('.feature-card .feature-icon').evaluateAll(elements => elements.map(element => ({
          text: element.textContent?.trim(),
          ariaHidden: element.getAttribute('aria-hidden'),
          background: getComputedStyle(element).backgroundColor,
          withinCard: (() => {
            const icon = element.getBoundingClientRect();
            const card = element.closest('.feature-card').getBoundingClientRect();
            return icon.left >= card.left && icon.right <= card.right && icon.top >= card.top && icon.bottom <= card.bottom;
          })(),
        })));
        if (JSON.stringify(metrics.emojiIcons.map(icon => icon.text)) !== JSON.stringify(['🖱️', '✍️', '🎨', '🖼️', '✂️', '🎬', '📖'])
          || metrics.emojiIcons.some(icon => icon.ariaHidden !== 'true' || !icon.withinCard)
          || new Set(metrics.emojiIcons.map(icon => icon.background)).size < 4) {
          throw new Error(`Emoji 风格没有呈现清晰、独立配色且不挤压操作的七枚功能贴纸：${JSON.stringify(metrics.emojiIcons)}`);
        }
      }
      visualSignatures.add(JSON.stringify([
        skin.kind,
        metrics.brand,
        metrics.surface,
        metrics.shellBackgroundImage,
        metrics.heroRadius,
      ]));
      report.screenshots.push(await screenshotElement(skinPopup.locator('.popup-shell'), `popup-interface-${skin.value}.png`));

      await skinPopup.evaluate(() => document.documentElement.classList.add('dark'));
      await skinPopup.waitForTimeout(skin.kind === 'palette' ? 200 : 80);
      const darkMetrics = await skinPopup.evaluate(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          brand: rootStyle.getPropertyValue('--brand').trim(),
          elementPrimary: rootStyle.getPropertyValue('--el-color-primary').trim(),
          surface: rootStyle.getPropertyValue('--surface').trim(),
          ink: rootStyle.getPropertyValue('--ink').trim(),
          actionText: getComputedStyle(document.querySelector('.translate-button')).color,
          translateButtonBackground: getComputedStyle(document.querySelector('.translate-button')).backgroundColor,
          translateButtonBackgroundImage: getComputedStyle(document.querySelector('.translate-button')).backgroundImage,
          shellBackgroundImage: getComputedStyle(document.querySelector('.popup-shell')).backgroundImage,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
      });
      darkMetrics.textContrast = contrastRatio(darkMetrics.ink, darkMetrics.surface);
      darkMetrics.motifs = await inspectInterfaceMotif(skinPopup.locator('.popup-shell'), skin);
      darkMetrics.actionContrast = skin.kind === 'palette'
        ? contrastRatio(darkMetrics.actionText, darkMetrics.translateButtonBackground)
        : null;
      if (darkMetrics.horizontalOverflow
        || darkMetrics.surface !== skin.darkSurface
        || !darkMetrics.brand
        || !darkMetrics.ink
        || darkMetrics.textContrast < 4.5
        || (skin.kind === 'palette' && (
          darkMetrics.actionContrast < 4.5
          || JSON.stringify(parseCssColor(darkMetrics.translateButtonBackground)) !== JSON.stringify(parseCssColor(darkMetrics.brand))
          || darkMetrics.translateButtonBackgroundImage !== 'none'
          || darkMetrics.shellBackgroundImage === 'none'
          || darkMetrics.elementPrimary !== darkMetrics.brand
        ))) {
        throw new Error(`${skin.label}暗色布局异常：${JSON.stringify(darkMetrics)}`);
      }
      report.screenshots.push(await screenshotElement(skinPopup.locator('.popup-shell'), `popup-interface-${skin.value}-dark.png`));
      await skinPopup.evaluate(() => document.documentElement.classList.remove('dark'));

      // 用明显长于中文的德文式文案逐套验证关键操作可换行且不会造成横向溢出。
      await skinPopup.evaluate(() => {
        const longCopy = new Map([
          ['.translate-label', 'Diese gesamte Webseite jetzt in die ausgewählte Sprache übersetzen'],
          ['.feature-card:nth-child(1) strong', 'Übersetzung beim Bewegen des Mauszeigers'],
          ['.feature-card:nth-child(3) strong', 'Darstellung der Übersetzung anpassen'],
          ['[data-popup-quick-feature="document"] strong', 'Dokumente in mehreren Sprachen übersetzen'],
        ]);
        for (const [selector, value] of longCopy) {
          const element = document.querySelector(selector);
          if (element) element.textContent = value;
        }
      });
      const multilingualMetrics = await skinPopup.evaluate(() => {
        const selectors = ['.translate-button', '.feature-card:nth-child(1)', '.feature-card:nth-child(3)', '[data-popup-quick-feature="document"]'];
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          shellHeight: document.querySelector('.popup-shell')?.getBoundingClientRect().height || 0,
          items: selectors.map(selector => {
            const element = document.querySelector(selector);
            return {
              selector,
              clientWidth: element?.clientWidth || 0,
              scrollWidth: element?.scrollWidth || 0,
            };
          }),
        };
      });
      multilingualMetrics.contentHeight = await inspectPopupContentHeight(skinPopup, `${skin.label}长文案`);
      if (multilingualMetrics.horizontalOverflow
        || multilingualMetrics.items.some(item => item.scrollWidth > item.clientWidth + 1)) {
        throw new Error(`${skin.label}无法容纳长文案：${JSON.stringify(multilingualMetrics)}`);
      }
      report.screenshots.push(await screenshotElement(skinPopup.locator('.popup-shell'), `popup-interface-${skin.value}-long-copy.png`));
      skinCases.push({
        ...skin,
        designMatrix,
        optionsMetrics,
        metrics,
        darkMetrics,
        multilingualMetrics,
      });
    }
    // Edge 的 CDP 附加在长皮肤矩阵后新建 Target 可能激活原生窗口。
    // 保留同一隔离页，每项先完整离开 Popup 再重新加载，销毁旧文档及组件状态。
    await assertTestBrowserRemainsBackground(context, '皮肤矩阵后重建 Popup 文档前');
    await skinPopup.goto('about:blank', {waitUntil: 'domcontentloaded', timeout});
    report.skinPopupLifecycle = {
      isolatedPages: 1,
      fullNavigations: expectedInterfaceSkins.length,
      appearanceReopenNavigations: 0,
      appearanceReopenMode: 'blank-then-popup',
    };
    if (visualSignatures.size !== expectedInterfaceSkins.length) {
      throw new Error(`所有皮肤没有形成独立视觉签名：${visualSignatures.size}`);
    }

    // 配色型皮肤的共享适配层必须覆盖独立 feature，而不是只覆盖通用设置组件。
    // 同时用纸张护眼遍历全部导航，阻止任何新页面重新引入大面积纯白表面。
    const paletteSkins = expectedInterfaceSkins.filter(item => item.kind === 'palette');
    const specialtyPages = [
      {section: 'settings-services', ready: '.service-detail'},
      {section: 'settings-image-translation', ready: '.image-ocr-pack-card'},
      {section: 'settings-area-translation', ready: '.area-settings-note'},
      {section: 'settings-vocabulary', ready: '.vocabulary-book'},
    ];
    const auditLargeWhiteSurfaces = () => page.evaluate(() => {
      const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim().toLowerCase();
      // 明亮皮肤可以有意使用纯白内容卡；只拦截与当前皮肤语义底色不一致的硬编码白块。
      if (surface === '#fff' || surface === '#ffffff') return [];
      const excluded = '.style-preview-example, .interface-skin-live-preview, .popup-layout-live-preview';
      return [...document.querySelectorAll('.settings-card *')]
        .filter(element => {
          if (!(element instanceof HTMLElement) || element.closest(excluded)) return false;
          const rect = element.getBoundingClientRect();
          if (rect.width * rect.height < 2800 || rect.width < 90 || rect.height < 26) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) > 0
            && style.backgroundColor === 'rgb(255, 255, 255)';
        })
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          width: Math.round(element.getBoundingClientRect().width),
          height: Math.round(element.getBoundingClientRect().height),
        }));
    });
    const paletteSurfaceCoverage = [];
    for (const skin of paletteSkins) {
      await interfaceSettingsGroup.locator(`.interface-skin-option[data-skin="${skin.value}"]`).click();
      await page.waitForFunction(value => document.documentElement.dataset.interfaceSkin === value, skin.value, {timeout});
      for (const specialty of specialtyPages) {
        await page.locator(`button[data-section="${specialty.section}"]`).click();
        await page.locator(specialty.ready).first().waitFor({state: 'visible', timeout});
        await page.waitForTimeout(120);
        const whiteSurfaces = await auditLargeWhiteSurfaces();
        if (whiteSurfaces.length) {
          throw new Error(`${skin.label}在${specialty.section}仍有大面积纯白表面：${JSON.stringify(whiteSurfaces)}`);
        }
        paletteSurfaceCoverage.push({skin: skin.value, section: specialty.section});
      }
      await page.locator('button[data-section="settings-interface"]').click();
      await liveSkinPreview.waitFor({state: 'visible', timeout});
    }

    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="paper"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'paper', undefined, {timeout});
    const paperPageCoverage = [];
    for (const [section] of expectedNavigation) {
      await page.locator(`button[data-section="${section}"]`).click();
      await page.locator(`button[data-section="${section}"].active`).waitFor({state: 'visible', timeout});
      await page.waitForTimeout(120);
      const whiteSurfaces = await auditLargeWhiteSurfaces();
      if (whiteSurfaces.length) {
        throw new Error(`纸张护眼在${section}仍有大面积纯白表面：${JSON.stringify(whiteSurfaces)}`);
      }
      paperPageCoverage.push(section);
      report.screenshots.push(await screenshot(page, `settings-paper-${section}.png`));
    }
    report.paletteSurfaceCoverage = paletteSurfaceCoverage;
    report.paperPageCoverage = paperPageCoverage;
    report.assertions.paletteSurfaceCoverage = true;

    await page.locator('button[data-section="settings-interface"]').click();
    await interfaceSettingsGroup.waitFor({state: 'visible', timeout});
    const minimalSkinCase = skinCases.find(item => item.value === 'minimal');
    if (!minimalSkinCase) throw new Error('缺少简约风格验证结果');
    const minimalPopupMetrics = minimalSkinCase.metrics;
    const multilingualMetrics = minimalSkinCase.multilingualMetrics;

    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="minimal"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'minimal', undefined, {timeout});
    await page.waitForTimeout(400);

    await popupModuleTab.click();
    await popupLayoutEditor.locator('[data-popup-layout-module="quickFeatures"] .popup-layout-hide').click();
    await popupLayoutEditor.locator('[data-popup-layout-module="footer"] .popup-layout-hide').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-popup-layout-module="quickFeatures"]') === null
      && document.querySelector('[data-popup-layout-module="footer"]') === null
      && document.querySelector('.popup-layout-hidden-chip') !== null
    ), undefined, {timeout});
    await page.waitForTimeout(500);

    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 前');
    await skinPopup.setViewportSize({width: 400, height: 600});
    await skinPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
    report.skinPopupLifecycle.appearanceReopenNavigations += 1;
    await skinPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
    await skinPopup.waitForTimeout(350);
    if (await skinPopup.locator('.features').count() !== 0) {
      const visibilityDiagnostics = await skinPopup.locator('.popup-shell').evaluate(element => ({
        quickFeatures: element.getAttribute('data-popup-quick-features-visible'),
        siteRule: element.getAttribute('data-popup-site-rule-visible'),
        footer: element.getAttribute('data-popup-footer-visible'),
        moduleOrder: element.getAttribute('data-popup-module-order'),
      }));
      throw new Error(`关闭快捷功能栏后 Popup 仍显示快捷功能：${JSON.stringify(visibilityDiagnostics)}`);
    }
    if (await skinPopup.locator('footer').count() !== 0) throw new Error('关闭底部信息栏后 Popup 仍显示底部信息');
    if (await skinPopup.locator('main[data-interface-skin="minimal"]').count() !== 1) {
      throw new Error('Popup 重开后没有应用简约风格');
    }
    const popupMetrics = await inspectPopupContentHeight(skinPopup, '简约风格隐藏栏目');
    if (popupMetrics.shellHeight >= minimalPopupMetrics.shellHeight - 40) {
      throw new Error(`隐藏 Popup 栏目后空白区域没有随内容收缩：${JSON.stringify(popupMetrics)}`);
    }
    report.screenshots.push(await screenshotElement(skinPopup.locator('.popup-shell'), 'popup-interface-minimal-hidden-sections.png'));
    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 完成简约隐藏栏目检查后');
    await skinPopup.goto('about:blank', {waitUntil: 'domcontentloaded', timeout});

    // 默认风格的完整布局与隐藏栏目均按内容高度排版，不保留固定空白。
    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="default"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'default', undefined, {timeout});
    await page.waitForTimeout(500);
    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 进行默认隐藏栏目检查前');
    await skinPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
    report.skinPopupLifecycle.appearanceReopenNavigations += 1;
    await skinPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
    await skinPopup.waitForTimeout(350);
    const defaultHiddenMetrics = await inspectPopupContentHeight(skinPopup, '默认风格隐藏栏目');
    const defaultSkinCase = skinCases.find(item => item.value === 'default');
    if (!defaultSkinCase || defaultHiddenMetrics.shellHeight >= defaultSkinCase.metrics.shellHeight - 40) {
      throw new Error(`默认风格隐藏栏目后没有按内容收缩：${JSON.stringify(defaultHiddenMetrics)}`);
    }
    report.screenshots.push(await screenshotElement(skinPopup.locator('.popup-shell'), 'popup-interface-default-hidden-sections.png'));
    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 完成默认隐藏栏目检查后');
    await skinPopup.goto('about:blank', {waitUntil: 'domcontentloaded', timeout});

    await popupLayoutEditor.locator('.popup-layout-hidden-chip').filter({hasText: '快捷功能栏'}).getByRole('button', {name: '添加快捷功能栏', exact: true}).click();
    await popupLayoutEditor.locator('.popup-layout-hidden-chip').filter({hasText: '底部信息栏'}).getByRole('button', {name: '添加底部信息栏', exact: true}).click();
    await page.waitForFunction(() => (
      document.querySelector('[data-popup-layout-module="quickFeatures"]') !== null
      && document.querySelector('[data-popup-layout-module="footer"]') !== null
    ), undefined, {timeout});
    await popupLayoutEditor.getByRole('button', {name: '恢复默认顺序'}).click();
    await page.waitForFunction((expected) => JSON.stringify(
      [...document.querySelectorAll('[data-popup-layout-editor] [data-popup-layout-module]')]
        .map(element => element.getAttribute('data-popup-layout-module')),
    ) === JSON.stringify(expected), defaultLayoutOrder, {timeout});
    await page.waitForTimeout(500);
    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 进行默认完整栏目检查前');
    await skinPopup.goto(`${extensionOrigin}/popup.html`, {waitUntil: 'domcontentloaded', timeout});
    report.skinPopupLifecycle.appearanceReopenNavigations += 1;
    await skinPopup.locator('.popup-shell').waitFor({state: 'visible', timeout});
    await skinPopup.waitForTimeout(350);
    const defaultFullMetrics = await inspectPopupContentHeight(skinPopup, '恢复默认完整栏目');
    const defaultFooterBottomGap = defaultFullMetrics.scrolling.longContent
      ? defaultFullMetrics.scrolling.end.lastModuleBottomGap
      : defaultFullMetrics.lastModuleBottomGap;
    if (defaultFullMetrics.lastModule !== 'footer'
      || Math.abs(defaultFooterBottomGap - 3) > 1
      || defaultFullMetrics.shellHeight <= defaultHiddenMetrics.shellHeight + 40) {
      throw new Error(`默认完整布局的页脚边距或内容伸展异常：${JSON.stringify(defaultFullMetrics)}`);
    }
    const restoredPopupModuleOrder = await skinPopup.locator('[data-popup-module]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-module')),
    );
    if (JSON.stringify(restoredPopupModuleOrder) !== JSON.stringify(defaultLayoutOrder)) {
      throw new Error(`恢复默认后 Popup 模块顺序异常：${JSON.stringify(restoredPopupModuleOrder)}`);
    }
    const restoredPopupQuickFeatureOrder = await skinPopup.locator('[data-popup-quick-feature]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-popup-quick-feature')),
    );
    if (JSON.stringify(restoredPopupQuickFeatureOrder) !== JSON.stringify(defaultQuickFeatureOrder)) {
      throw new Error(`恢复默认后快捷功能卡片顺序异常：${JSON.stringify(restoredPopupQuickFeatureOrder)}`);
    }
    const deliverablePopupSkins = [];
    for (const skin of ['ocean', 'emoji']) {
      await interfaceSettingsGroup.locator(`.interface-skin-option[data-skin="${skin}"]`).click();
      await page.waitForFunction(value => document.documentElement.dataset.interfaceSkin === value, skin, {timeout});
      await page.waitForTimeout(450);
      await skinPopup.reload({waitUntil: 'domcontentloaded', timeout});
      await skinPopup.waitForFunction(value => document.documentElement.dataset.interfaceSkin === value, skin, {timeout});
      await skinPopup.evaluate(() => document.documentElement.classList.remove('dark'));
      await skinPopup.waitForTimeout(220);
      const visibleOrder = await skinPopup.locator('[data-popup-module]').evaluateAll(elements => elements.map(element => element.getAttribute('data-popup-module')));
      if (JSON.stringify(visibleOrder) !== JSON.stringify(defaultLayoutOrder)) {
        throw new Error(`交付用 ${skin} 菜单栏没有恢复默认栏目顺序：${JSON.stringify(visibleOrder)}`);
      }
      const file = await screenshotElement(skinPopup.locator('.popup-shell'), `deliverable-popup-${skin}.png`);
      report.screenshots.push(file);
      deliverablePopupSkins.push({skin, moduleOrder: visibleOrder, file});
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('button[data-section="settings-interface"]').click();
    await liveSkinPreview.scrollIntoViewIfNeeded();
    report.screenshots.push(await screenshot(page, 'deliverable-settings-emoji-1440.png'));
    report.deliverablePopupSkins = deliverablePopupSkins;
    await interfaceSettingsGroup.locator('.interface-skin-option[data-skin="default"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceSkin === 'default', undefined, {timeout});
    await assertTestBrowserRemainsBackground(context, '复用 skinPopup 完成默认完整栏目与交付皮肤检查后');
    await skinPopup.close();
    await interfaceHostPage.close();

    report.informationArchitecture.interfaceSettings = {
      location: 'settings-interface',
      skinOptions: expectedInterfaceSkins.map(item => item.value),
      skinGroups: {
        utility: expectedInterfaceSkins.filter(item => item.kind !== 'palette').map(item => item.value),
        palette: expectedInterfaceSkins.filter(item => item.kind === 'palette').map(item => item.value),
      },
      selectedSkin: 'default',
      skinCases,
      minimalPopupMetrics,
      hiddenSections: ['popupQuickFeatures', 'popupFooter'],
      hiddenMinimalMetrics: popupMetrics,
      hiddenDefaultMetrics: defaultHiddenMetrics,
      fullDefaultMetrics: defaultFullMetrics,
      multilingualMetrics,
      popupLayout: {
        defaultOrder: defaultLayoutOrder,
        draggedOrder: draggedLayoutOrder,
        persistedOrder: persistedLayoutOrder,
        latestWriteOrder: latestWriteLayoutOrder,
        popupOrder: popupModuleOrder,
        reorderedModuleSpacing,
        restoredOrder: restoredPopupModuleOrder,
        keyboardReorder: true,
        livePreview: true,
      },
      popupQuickFeatures: {
        defaultOrder: defaultQuickFeatureOrder,
        customOrder: customQuickFeatureOrder,
        persistedOrder: persistedQuickFeatureOrder,
        popupOrder: popupQuickFeatureOrder,
        hiddenFeature: 'image',
        hiddenDefaultMetrics: defaultSingleFeatureHiddenMetrics,
        restoredOrder: restoredPopupQuickFeatureOrder,
      },
      popupRoundTrip: true,
    };
    report.persistenceCases.push({
      name: 'popupModuleOrder',
      before: defaultLayoutOrder,
      after: customLayoutOrder,
      reopened: popupModuleOrder,
    });
    report.persistenceCases.push({
      name: 'popupQuickFeatureOrderAndVisibility',
      before: defaultQuickFeatureOrder,
      after: {order: customQuickFeatureOrder, hidden: ['image']},
      reopened: popupQuickFeatureOrder,
    });
    report.quickClose.popupModuleOrder = true;
    report.quickClose.popupQuickFeatureOrderAndVisibility = true;
    report.crossPageSync.popupModuleOrder = true;
    report.crossPageSync.popupQuickFeatureOrderAndVisibility = true;
    report.latestWriteWins.popupModuleOrder = true;
    report.assertions.interfaceSettings = true;
    report.assertions.interfaceSkinMatrix = true;
    report.assertions.interfaceSkinLightDarkResponsiveMatrix = true;
    report.assertions.interfaceMotifParity = true;
    report.assertions.interfaceVisibility = true;
    report.assertions.popupLayoutPersistence = true;
    report.assertions.popupQuickFeatureLayoutPersistence = true;
    report.assertions.multilingualInterfaceLayout = true;

    await page.locator('button[data-section="settings-model-usage"]').click();
    await page.locator('#settings-model-usage').waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.querySelector('#settings-model-usage .usage-state-card, #settings-model-usage .usage-summary-grid'), undefined, {timeout});
    const modelUsageFixture = await seedModelUsageFixture(page);
    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await page.locator('#settings-model-usage').waitFor({state: 'visible', timeout});
    const usageTokenValue = () => page.locator('#settings-model-usage .usage-token-card .usage-card-heading strong').textContent()
      .then(value => Number(String(value || '').replace(/[^0-9]/g, '')));
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, modelUsageFixture.allTokens, {timeout});
    const filterPlaceholders = await page.locator('#settings-model-usage .usage-select-shell .el-select__placeholder').allTextContents();
    if (JSON.stringify(filterPlaceholders.map(value => value.trim())) !== JSON.stringify(['全部 AI 服务', '全部模型'])) {
      throw new Error(`模型用量筛选占位文字异常：${JSON.stringify(filterPlaceholders)}`);
    }
    const filterPlaceholderMetrics = await page.locator('#settings-model-usage .usage-select-shell .el-select__placeholder').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent?.trim(),
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        color: style.color,
        width: rect.width,
        height: rect.height,
        parentOpacity: getComputedStyle(element.parentElement || element).opacity,
      };
    }));
    if (filterPlaceholderMetrics.some(metric => metric.width <= 0 || metric.height <= 0 || metric.opacity === '0' || metric.visibility !== 'visible')) {
      throw new Error('模型用量筛选占位文字不可见：' + JSON.stringify(filterPlaceholderMetrics));
    }
    await page.locator('#settings-model-usage .usage-select-shell').first().click();
    const openFilterDropdown = page.locator('.el-select-dropdown:visible').first();
    await openFilterDropdown.waitFor({state: 'visible', timeout});
    const filterDropdownMetrics = await openFilterDropdown.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        width: rect.width,
        height: rect.height,
      };
    });
    if (filterDropdownMetrics.width <= 0 || filterDropdownMetrics.height <= 0) {
      throw new Error('模型用量筛选下拉框展开尺寸异常：' + JSON.stringify(filterDropdownMetrics));
    }
    report.screenshots.push(await screenshot(page, 'settings-model-usage-filter-open.png'));
    await page.keyboard.press('Escape');
    await openFilterDropdown.waitFor({state: 'hidden', timeout});
    const averageDisclosure = page.locator('#settings-model-usage details.usage-average-card');
    if (await averageDisclosure.getAttribute('open') !== null) {
      throw new Error('模型用量平均构成没有默认收起');
    }
    const requestDisclosure = page.locator('#settings-model-usage details.usage-request-log-card');
    if (await requestDisclosure.getAttribute('open') !== null
      || !(await requestDisclosure.locator('summary').textContent())?.includes('请求记录')) {
      throw new Error('模型用量请求记录没有显示默认收起的明确入口');
    }
    const allCoverageNotice = await page.locator('#settings-model-usage .usage-coverage-note').textContent();
    if (!allCoverageNotice?.includes('66.7%')) {
      throw new Error(`全部调用 Token 上报率没有计入失败请求：${allCoverageNotice}`);
    }
    await averageDisclosure.locator('summary').click();
    const allAverageValues = (await page.locator('#settings-model-usage .usage-average-value strong').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(allAverageValues) !== JSON.stringify([
      String(modelUsageFixture.allAverageUncachedInput),
      String(modelUsageFixture.allAverageCachedInput),
      String(modelUsageFixture.allAverageOutput),
    ])) {
      throw new Error(`全部范围的平均无缓存输入/缓存读取/输出异常：${JSON.stringify(allAverageValues)}`);
    }
    const breakdownHeaders = (await page.locator('#settings-model-usage .usage-breakdown-heading > *').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(breakdownHeaders) !== JSON.stringify(['服务 / 模型', '输入', '缓存', '输出', '次数', '总计'])) {
      throw new Error('模型用量分布列异常：' + JSON.stringify(breakdownHeaders));
    }
    const breakdownTotals = (await page.locator('#settings-model-usage .usage-breakdown-total').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(breakdownTotals) !== JSON.stringify(['600', '500', '150', '—'])) {
      throw new Error('模型用量分布排序异常：' + JSON.stringify(breakdownTotals));
    }
    const breakdownRequests = (await page.locator('#settings-model-usage .usage-breakdown-requests').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(breakdownRequests) !== JSON.stringify(['1', '3', '1', '1'])) {
      throw new Error('模型用量请求次数列异常：' + JSON.stringify(breakdownRequests));
    }
    await page.getByRole('button', {name: '按输入排序', exact: true}).click();
    const inputValues = await page.locator('#settings-model-usage .usage-breakdown-value').evaluateAll(elements => elements
      .filter((_, index) => index % 5 === 0)
      .map(element => element.textContent?.trim()));
    // DeepSeek 的这条失败调用没有上报 Token，必须明确显示“—”并排在末尾。
    // 不把它强制转为 0；真实上报的零 Token 与缺少用量是不同状态。
    const breakdownSortedByInput = JSON.stringify(inputValues) === JSON.stringify(['420', '300', '100', '—']);
    if (!breakdownSortedByInput) throw new Error('模型用量没有按输入 Token 降序排列并将未知值置后：' + JSON.stringify(inputValues));
    await page.getByRole('button', {name: '按输出排序', exact: true}).click();
    const outputValues = (await page.locator('#settings-model-usage .usage-breakdown-list > button .usage-breakdown-value').evaluateAll(elements => elements
      .filter((_, index) => index % 5 === 2)
      .map(element => element.textContent?.trim())));
    if (JSON.stringify(outputValues) !== JSON.stringify(['200', '180', '50', '—'])) {
      throw new Error('模型用量没有按输出 Token 降序排列：' + JSON.stringify(outputValues));
    }
    await page.getByRole('button', {name: '按次数排序', exact: true}).click();
    const requestsSortedByCount = (await page.locator('#settings-model-usage .usage-breakdown-requests').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(requestsSortedByCount) !== JSON.stringify(['3', '1', '1', '1'])) {
      throw new Error('模型用量没有按请求次数降序排列：' + JSON.stringify(requestsSortedByCount));
    }
    await page.getByRole('button', {name: '按总计排序', exact: true}).click();
    await selectElementPlusOption(page, '模型用量服务', '月之暗面/Kimi');
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, modelUsageFixture.kimiTokens, {timeout});
    await selectElementPlusOption(page, '模型用量模型', 'kimi-k2.6');
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, modelUsageFixture.kimiK2Tokens, {timeout});
    const usageRangeGroup = page.getByRole('radiogroup', {name: '模型用量时间范围'});
    const usageThirtyDayRadio = usageRangeGroup.getByRole('radio', {name: '30 天', exact: true});
    await usageThirtyDayRadio.focus();
    await usageThirtyDayRadio.press('Home');
    await page.waitForFunction(() => {
      const group = document.querySelector('[role="radiogroup"][aria-label="模型用量时间范围"]');
      const selected = group?.querySelector('[role="radio"][aria-checked="true"]');
      return selected?.textContent?.trim() === '今日'
        && selected === document.activeElement
        && group?.querySelectorAll('[role="radio"][tabindex="0"]').length === 1;
    }, undefined, {timeout});
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, modelUsageFixture.todayKimiTokens, {timeout});
    const todayAverageValues = (await page.locator('#settings-model-usage .usage-average-value strong').allTextContents())
      .map(value => value.trim());
    if (JSON.stringify(todayAverageValues) !== JSON.stringify([
      String(modelUsageFixture.todayKimiAverageUncachedInput),
      String(modelUsageFixture.todayKimiAverageCachedInput),
      String(modelUsageFixture.todayKimiAverageOutput),
    ])) {
      throw new Error(`今日范围的平均无缓存输入/缓存读取/输出异常：${JSON.stringify(todayAverageValues)}`);
    }
    const usageRequestCount = Number((await page.locator('#settings-model-usage .usage-compact-card').first().locator('strong').textContent())?.replace(/[^0-9]/g, '') || 0);
    if (usageRequestCount !== 2) throw new Error(`Kimi 今日请求数异常：${usageRequestCount}`);
    const coverageNotice = (await page.locator('#settings-model-usage .usage-coverage-note').textContent())?.replace(/\s+/g, ' ').trim();
    if (!coverageNotice?.includes('50%')) throw new Error(`Token 上报覆盖率异常：${coverageNotice}`);
    await page.getByRole('button', {name: '清除统计', exact: true}).click();
    const resetDialog = page.getByRole('alertdialog', {name: '清除本机模型用量？'});
    await resetDialog.waitFor({state: 'visible', timeout});
    if (!await resetDialog.getByText(/不会删除 API Key、翻译设置、FluentRead 译文缓存或配置历史/).isVisible()) {
      throw new Error('模型用量重置没有明确隔离其他本地数据');
    }
    const resetCancelButton = resetDialog.getByRole('button', {name: '取消', exact: true});
    const resetConfirmButton = resetDialog.getByRole('button', {name: '确认清除统计', exact: true});
    if (!await resetCancelButton.evaluate(button => button === document.activeElement)) {
      throw new Error('模型用量重置对话框没有将初始焦点放在安全的取消按钮');
    }
    if (await page.locator('.settings-app').getAttribute('inert') === null) {
      throw new Error('模型用量重置对话框打开时背景设置仍可交互');
    }
    await resetCancelButton.press('Shift+Tab');
    if (!await resetConfirmButton.evaluate(button => button === document.activeElement)) {
      throw new Error('模型用量重置对话框没有向后闭环焦点');
    }
    await resetConfirmButton.press('Tab');
    if (!await resetCancelButton.evaluate(button => button === document.activeElement)) {
      throw new Error('模型用量重置对话框没有向前闭环焦点');
    }
    await resetCancelButton.click();
    await resetDialog.waitFor({state: 'hidden', timeout});
    if (await page.locator('.settings-app').getAttribute('inert') !== null) {
      throw new Error('模型用量重置对话框关闭后背景仍被锁定');
    }
    if (!await page.getByRole('button', {name: '清除统计', exact: true}).evaluate(button => button === document.activeElement)) {
      throw new Error('模型用量重置对话框关闭后没有恢复触发按钮焦点');
    }
    if (await usageTokenValue() !== modelUsageFixture.todayKimiTokens) throw new Error('取消清除后统计发生变化');

    await selectElementPlusOption(page, '模型用量服务', 'DeepSeek');
    await selectElementPlusOption(page, '模型用量模型', 'deepseek-chat');
    await page.waitForFunction(() => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return text.trim() === '—'
        && document.querySelector('#settings-model-usage .usage-compact-card')?.textContent?.includes('1');
    }, undefined, {timeout});
    if (await page.locator('#settings-model-usage .usage-ratio').count() !== 0) {
      throw new Error('零 Token 请求仍显示了虚假的输入输出比例');
    }
    if (!await page.getByText('缓存读取未上报', {exact: true}).isVisible()
      || !await page.getByText('暂时无法拆分输入与缓存构成', {exact: true}).isVisible()) {
      throw new Error('零 Token 请求没有显示缓存明细未上报边界');
    }
    const zeroTokenBreakdownWidth = await page.locator('#settings-model-usage .usage-breakdown-copy i b').first().evaluate(bar => bar.style.width);
    if (zeroTokenBreakdownWidth !== '0%') {
      throw new Error(`零 Token 分布行仍显示了虚假长度：${zeroTokenBreakdownWidth}`);
    }
    await selectElementPlusOption(page, '模型用量服务', '全部 AI 服务');
    await selectElementPlusOption(page, '模型用量模型', '全部模型');
    await usageRangeGroup.getByRole('radio', {name: '30 天', exact: true}).click();
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, modelUsageFixture.allTokens, {timeout});
    report.modelUsage = {
      ...modelUsageFixture,
      filteredProvider: 'moonshot',
      filteredModel: 'kimi-k2.6',
      todayRequestCount: usageRequestCount,
      allAverageUncachedInput: modelUsageFixture.allAverageUncachedInput,
      allAverageCachedInput: modelUsageFixture.allAverageCachedInput,
      allAverageOutput: modelUsageFixture.allAverageOutput,
      todayAverageUncachedInput: modelUsageFixture.todayKimiAverageUncachedInput,
      todayAverageCachedInput: modelUsageFixture.todayKimiAverageCachedInput,
      todayAverageOutput: modelUsageFixture.todayKimiAverageOutput,
      breakdownHeaders,
      breakdownTotals,
      breakdownRequests,
      breakdownSortedByInput,
      breakdownSortedByOutput: true,
      breakdownSortedByRequests: true,
      breakdownSortedByTotal: true,
      filterPlaceholderMetrics,
      filterDropdownMetrics,
      tokenCoverage: coverageNotice,
      allCallTokenCoverage: allCoverageNotice?.trim(),
      progressiveDisclosure: true,
      resetCancelPreserved: true,
      rangeKeyboard: true,
      resetFocusLoop: true,
      zeroTokenEncoding: true,
    };
    report.screenshots.push(await screenshot(page, 'settings-model-usage-seeded.png'));
    report.assertions.modelUsageFilters = true;
    report.assertions.modelUsageResetIsolation = true;
    report.assertions.modelUsageRangeKeyboard = true;
    report.assertions.modelUsageResetFocus = true;
    report.assertions.modelUsageZeroTokenEncoding = true;

    await page.locator('button[data-section="settings-general"]').click();
    const refreshEvent = await appendModelUsageRefreshEvent(page);
    await page.locator('button[data-section="settings-model-usage"]').click();
    const refreshedTokenTotal = modelUsageFixture.allTokens + refreshEvent.deltaTokens;
    await page.waitForFunction(expected => {
      const text = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong')?.textContent || '';
      return Number(text.replace(/[^0-9]/g, '')) === expected;
    }, refreshedTokenTotal, {timeout});
    report.modelUsage.returnRefreshTokens = refreshedTokenTotal;
    report.assertions.modelUsageReturnRefresh = true;
    await page.locator('button[data-section="settings-general"]').click();
    const themeGroup = page.getByRole('radiogroup', {name: '界面主题'});
    const initialThemeRadio = themeGroup.locator('[role="radio"][aria-checked="true"]');
    await initialThemeRadio.focus();
    await initialThemeRadio.press('ArrowRight');
    await page.waitForTimeout(50);
    const keyboardSelectedTheme = themeGroup.locator('[role="radio"][aria-checked="true"]');
    if (await keyboardSelectedTheme.count() !== 1 || !await keyboardSelectedTheme.evaluate(element => element === document.activeElement)) {
      throw new Error('分段选择器没有用方向键切换并移动焦点');
    }
    await themeGroup.getByRole('radio', {name: '暗色主题', exact: true}).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, {timeout});
    const darkColors = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
      surface: getComputedStyle(document.querySelector('.settings-group-body')).backgroundColor,
    }));
    const isDarkColor = value => {
      const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
      return channels.length === 3 && channels.reduce((sum, channel) => sum + channel, 0) / 3 < 90;
    };
    if (!Object.values(darkColors).every(isDarkColor)) throw new Error(`暗色主题表面仍为亮色：${JSON.stringify(darkColors)}`);
    report.screenshots.push(await screenshot(page, 'settings-dark-general.png'));
    await page.locator('button[data-section="settings-services"]').click();
    if (await page.getByTestId('model-thinking-control').count() === 0) {
      await page.locator('.service-item[data-service-value="openai"]').click();
    }
    const darkAdvancedSettings = page.getByTestId('custom-service-advanced');
    await darkAdvancedSettings.waitFor({state: 'visible', timeout});
    const darkThinkingSwitch = darkAdvancedSettings.getByRole('switch', {
      name: '当前模型是否启用 Thinking',
      includeHidden: true,
    });
    const darkThinkingControl = darkThinkingSwitch.locator('..');
    if (await darkThinkingControl.isVisible()) throw new Error('模型 Thinking 没有收纳到关闭的高级设置中');
    await darkAdvancedSettings.locator('summary').click();
    await darkThinkingControl.waitFor({state: 'visible', timeout});
    const thinkingDarkSurface = await darkAdvancedSettings
      .evaluate(element => getComputedStyle(element).backgroundColor);
    if (!isDarkColor(thinkingDarkSurface)) {
      throw new Error(`包含模型 Thinking 的高级设置仍为亮色：${thinkingDarkSurface}`);
    }
    report.informationArchitecture.modelThinkingDarkSurface = thinkingDarkSurface;
    report.screenshots.push(await screenshot(page, 'settings-dark-services.png'));
    await darkAdvancedSettings.locator('summary').click();
    if (await darkAdvancedSettings.getAttribute('open') !== null) {
      throw new Error('暗色验证后没有恢复高级设置的默认折叠状态');
    }
    await page.locator('button[data-section="settings-translation"]').click();
    report.screenshots.push(await screenshot(page, 'settings-dark-translation.png'));
    await page.locator('button[data-section="settings-interface"]').click();
    const darkLoadingStyleSurfaces = await page.locator('.loading-style-option').evaluateAll(cards => (
      cards.map(card => ({
        selected: card.classList.contains('selected'),
        backgroundColor: getComputedStyle(card).backgroundColor,
      }))
    ));
    const selectedDarkLoadingStyle = darkLoadingStyleSurfaces.find(item => item.selected);
    if (darkLoadingStyleSurfaces.length !== expectedLoadingStyles.length
      || darkLoadingStyleSurfaces.filter(item => !item.selected).some(item => !isDarkColor(item.backgroundColor))
      || !selectedDarkLoadingStyle
      || !selectedDarkLoadingStyle.backgroundColor.startsWith('rgba(')) {
      throw new Error(`段落加载样式暗色卡片仍为亮色：${JSON.stringify(darkLoadingStyleSurfaces)}`);
    }
    report.screenshots.push(await screenshot(page, 'settings-dark-loading-styles.png'));
    await page.locator('button[data-section="settings-model-usage"]').click();
    const usageDarkSurface = await page.locator('#settings-model-usage .usage-card').first().evaluate(card => getComputedStyle(card).backgroundColor);
    if (!isDarkColor(usageDarkSurface)) throw new Error(`模型用量暗色卡片仍为亮色：${usageDarkSurface}`);
    report.screenshots.push(await screenshot(page, 'settings-dark-model-usage.png'));
    await page.locator('button[data-section="settings-data"]').click();
    report.screenshots.push(await screenshot(page, 'settings-dark-data.png'));
    await page.locator('button[data-section="settings-general"]').click();
    await themeGroup.getByRole('radio', {name: '亮色主题', exact: true}).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), undefined, {timeout});
    report.assertions.segmentedKeyboard = true;
    report.assertions.darkTheme = true;

    const generalSection = page.locator('#settings-general');
    const generalGroups = (await page.locator('.settings-section:visible .settings-group-heading h2').allTextContents())
      .map(title => title.trim());
    if (JSON.stringify(generalGroups) !== JSON.stringify(expectedGeneralGroups)) {
      throw new Error(`通用设置分组异常：${JSON.stringify(generalGroups)}`);
    }
    report.informationArchitecture.generalGroups = generalGroups;
    report.bilingualHighlightPreview = await verifyBilingualHighlightPreview(page);
    report.screenshots.push(report.bilingualHighlightPreview.screenshot);
    report.assertions.bilingualHighlightPreview = true;

    const defaultServiceCard = generalSection.getByTestId('default-translation-service-card');
    await defaultServiceCard.waitFor({state: 'visible', timeout});
    const defaultServiceMetrics = await defaultServiceCard.evaluate(card => {
      const item = card.closest('.settings-item');
      const label = item?.querySelector('.settings-item-copy strong');
      const description = item?.querySelector('.settings-item-copy small');
      const icon = card.querySelector('.service-brand-icon');
      const selected = card.querySelector('.el-select__placeholder');
      const cardStyle = getComputedStyle(card);
      const iconRect = icon?.getBoundingClientRect();
      const selectRect = card.querySelector('.el-select')?.getBoundingClientRect();
      return {
        defaultService: card.getAttribute('data-default-service'),
        label: label?.textContent?.trim(),
        description: description?.textContent?.trim(),
        selectedService: selected?.textContent?.trim(),
        backgroundImage: cardStyle.backgroundImage,
        controlShadow: cardStyle.boxShadow,
        controlDisplay: cardStyle.display,
        iconWidth: iconRect?.width || 0,
        selectWidth: selectRect?.width || 0,
      };
    });
    if (!defaultServiceMetrics.defaultService
      || defaultServiceMetrics.label !== '默认网页翻译服务'
      || defaultServiceMetrics.description !== '未单独指定方案时，全文、悬浮和划词翻译使用此服务。'
      || !defaultServiceMetrics.selectedService
      || defaultServiceMetrics.backgroundImage !== 'none'
      || defaultServiceMetrics.controlShadow !== 'none'
      || defaultServiceMetrics.controlDisplay !== 'grid'
      || defaultServiceMetrics.iconWidth < 39
      || defaultServiceMetrics.selectWidth < 180) {
      throw new Error(`默认翻译服务没有融入标准设置行：${JSON.stringify(defaultServiceMetrics)}`);
    }
    report.defaultServiceCard.desktop = defaultServiceMetrics;
    report.screenshots.push(await screenshot(page, 'settings-default-service-light.png'));
    report.assertions.defaultServiceHarmonious = true;

    const aiContextSwitch = page.getByRole('switch', {name: 'AI 精翻（智能上下文）', exact: true});
    if (await aiContextSwitch.count() !== 1) throw new Error('通用设置没有唯一的 AI 精翻（智能上下文）开关');
    if (await aiContextSwitch.isDisabled()) throw new Error('机器翻译作为默认服务时，AI 精翻（智能上下文）开关不可操作');
    const aiContextControl = aiContextSwitch.locator('..');
    if (!await aiContextControl.isVisible()) throw new Error('AI 智能上下文开关没有可见的交互控件');
    const aiContextBefore = await aiContextSwitch.getAttribute('aria-checked');
    if (!['true', 'false'].includes(aiContextBefore)) throw new Error(`AI 智能上下文开关状态异常：${aiContextBefore}`);
    await aiContextControl.click();
    await page.waitForFunction(
      previous => document.querySelector('[aria-label="AI 精翻（智能上下文）"]')
        ?.getAttribute('aria-checked') !== previous,
      aiContextBefore,
      {timeout},
    );
    const aiContextAfter = await aiContextSwitch.getAttribute('aria-checked');
    await aiContextControl.click();
    await page.waitForFunction(
      expected => document.querySelector('[aria-label="AI 精翻（智能上下文）"]')
        ?.getAttribute('aria-checked') === expected,
      aiContextBefore,
      {timeout},
    );
    const aiContextRestored = await aiContextSwitch.getAttribute('aria-checked');

    await page.locator('button[data-section="settings-services"]').click();
    const servicesSection = page.locator('#settings-services');
    const serviceCatalog = servicesSection.locator('.service-catalog');
    await serviceCatalog.waitFor({state: 'visible', timeout});
    const serviceOnlyMetrics = {
      catalogCount: await serviceCatalog.count(),
      defaultCardCount: await servicesSection.getByTestId('default-translation-service-card').count(),
      defaultSelectCount: await servicesSection.locator('[aria-label="默认网页翻译服务"]').count(),
      settingsGroupCount: await servicesSection.locator('.settings-group').count(),
      defaultService: await serviceCatalog.getAttribute('data-default-service'),
    };
    if (serviceOnlyMetrics.catalogCount !== 1
      || serviceOnlyMetrics.defaultCardCount !== 0
      || serviceOnlyMetrics.defaultSelectCount !== 0
      || serviceOnlyMetrics.settingsGroupCount !== 0
      || serviceOnlyMetrics.defaultService !== defaultServiceMetrics.defaultService) {
      throw new Error(`翻译服务页不是纯服务目录：${JSON.stringify(serviceOnlyMetrics)}`);
    }
    const expectedProviderServices = [
      'deepseek', 'tongyi', 'doubao', 'moonshot', 'zhipu', 'huanYuan',
      'huanYuanTranslation', 'yiyan', 'minimax', 'mimo', 'jieyue', 'openai',
      'gemini', 'claude', 'grok',
    ];
    const expectedPlatformServices = [
      'siliconCloud', 'newapi', 'infini', 'openrouter', 'groq', 'azureOpenai',
    ];
    const expectedMachineServices = [
      'freeTranslation', 'myMemory', 'microsoft', 'google', 'deepL', 'deeplx', 'xiaoniu', 'youdao', 'tencent',
    ];
    const providerServices = await serviceCatalog
      .locator('[data-service-subgroup="ai-providers"] .service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    const platformServices = await serviceCatalog
      .locator('[data-service-subgroup="ai-platforms"] .service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    if (JSON.stringify(providerServices) !== JSON.stringify(expectedProviderServices)) {
      throw new Error(`模型服务商分类或顺序异常：${JSON.stringify(providerServices)}`);
    }
    if (JSON.stringify(platformServices) !== JSON.stringify(expectedPlatformServices)) {
      throw new Error(`聚合平台分类或顺序异常：${JSON.stringify(platformServices)}`);
    }

    // 新版自定义 OpenAI 服务使用持久化的 custom:* profile，不再把不可用的旧
    // static `custom` 入口混入聚合平台。
    const customServiceFixture = {
      name: '浏览器自定义服务',
      endpoint: 'https://custom-browser-fixture.invalid/v1/chat/completions',
      apiKey: 'browser-custom-key-sensitive-sentinel',
      model: 'fixture-model-v1',
      secondModel: 'fixture-model-v2',
    };
    const customServiceGroup = serviceCatalog.locator('.custom-service-group');
    const customServiceCount = customServiceGroup.getByTestId('custom-service-count');
    const customServiceAdd = customServiceGroup.getByTestId('custom-service-add');
    if ((await customServiceCount.textContent())?.trim() !== '0 / 20') {
      throw new Error(`自定义服务初始计数异常：${await customServiceCount.textContent()}`);
    }
    if (await customServiceAdd.isDisabled()) throw new Error('空自定义服务列表无法添加首个服务');
    let customServiceId;

    const machineGroup = serviceCatalog.locator('[data-service-section="machine"]');
    const machineServices = await machineGroup.locator('.service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    const chromeMachineServices = [...expectedMachineServices, 'chromeTranslator'];
    if (JSON.stringify(machineServices) !== JSON.stringify(expectedMachineServices)
      && JSON.stringify(machineServices) !== JSON.stringify(chromeMachineServices)) {
      throw new Error(`机器翻译分类或顺序异常：${JSON.stringify(machineServices)}`);
    }
    const machineToggle = machineGroup.locator('[data-service-section-toggle="machine"]');
    if (await machineToggle.count() !== 1) throw new Error('机器翻译分组缺少唯一折叠按钮');
    if (await machineToggle.getAttribute('aria-expanded') === 'true') await machineToggle.click();
    if (await machineToggle.getAttribute('aria-expanded') !== 'false'
      || await machineGroup.locator('.service-item').first().isVisible()) {
      throw new Error('机器翻译分组无法收起');
    }
    const serviceSearch = serviceCatalog.getByPlaceholder('搜索翻译服务');
    await serviceSearch.fill('微软翻译');
    await machineGroup.locator('.service-item[data-service-value="microsoft"]').waitFor({state: 'visible', timeout});
    if (await machineToggle.getAttribute('aria-expanded') !== 'true') {
      throw new Error('搜索机器翻译时没有自动展开命中分组');
    }
    if (!await machineToggle.isDisabled()) throw new Error('搜索期间机器翻译折叠按钮仍可操作');
    await serviceSearch.fill('');
    if (await machineToggle.getAttribute('aria-expanded') !== 'false') {
      throw new Error('清空搜索后没有恢复机器翻译折叠状态');
    }
    if (await machineToggle.isDisabled()) throw new Error('清空搜索后机器翻译折叠按钮没有恢复可用');
    report.screenshots.push(await screenshot(page, 'settings-service-catalog-collapsed.png'));
    await machineToggle.click();
    if (await machineToggle.getAttribute('aria-expanded') !== 'true') throw new Error('机器翻译分组无法重新展开');

    const defaultServiceItem = serviceCatalog.locator(
      `.service-item[data-service-value="${defaultServiceMetrics.defaultService}"]`,
    );
    if (await defaultServiceItem.count() !== 1) throw new Error('服务目录没有显示当前默认服务');
    const defaultServiceKind = (await defaultServiceItem.locator('.service-copy small').textContent())?.trim();
    if (defaultServiceKind !== '机器翻译') {
      throw new Error(`AI 上下文开关用例没有运行在机器默认服务下：${defaultServiceKind}`);
    }
    report.informationArchitecture.services = serviceOnlyMetrics;
    report.informationArchitecture.serviceCatalogHierarchy = {
      providerServices,
      platformServices,
      machineServices,
      customService: {
        initialCount: 0,
        limit: 20,
        addEnabled: true,
      },
      machineSearchAutoExpanded: true,
      machineCollapsedStateRestored: true,
    };
    report.informationArchitecture.machineDefaultAiContext = {
      defaultService: defaultServiceMetrics.defaultService,
      serviceKind: defaultServiceKind,
      before: aiContextBefore,
      after: aiContextAfter,
      restored: aiContextRestored,
    };
    report.assertions.servicesCatalogOnly = true;
    report.assertions.serviceCatalogHierarchy = true;
    report.assertions.machineServiceGroupCollapsible = true;
    report.assertions.machineDefaultAiContextOperable = true;

    await page.locator('button[data-section="settings-translation"]').click();
    const translationSection = page.locator('#settings-translation');
    await translationSection.waitFor({state: 'visible', timeout});
    const translationGroups = (await page.locator('.settings-section:visible .settings-group-heading h2').allTextContents())
      .map(title => title.trim());
    if (JSON.stringify(translationGroups) !== JSON.stringify(expectedTranslationGroups)) {
      throw new Error(`翻译设置分组顺序异常：${JSON.stringify(translationGroups)}`);
    }
    report.informationArchitecture.translationGroups = translationGroups;
    report.assertions.translationGroupOrder = true;

    await page.locator('button[data-section="settings-general"]').click();
    const targetLanguageSelector = '[data-config-field="to"] input';
    const targetChange = await chooseDifferentSelectOption(page, targetLanguageSelector);
    await page.waitForTimeout(500);
    await page.locator('button[data-section="settings-data"]').click();
    await page.getByRole('heading', {name: '最近修改', exact: true}).waitFor({state: 'visible', timeout});
    await page.getByRole('heading', {name: '自动设置快照', exact: true}).waitFor({state: 'visible', timeout});
    const recentEntries = page.locator('#settings-data .version-panel').nth(0).locator('.version-entry');
    const backupEntries = page.locator('#settings-data .version-panel').nth(1).locator('.version-entry');
    if (await recentEntries.count() < 1 || await backupEntries.count() < 1) throw new Error('最近修改或自动设置快照没有建立基线');
    await backupEntries.first().click();
    const previewDialog = page.locator('.config-preview-dialog:visible');
    await previewDialog.waitFor({state: 'visible', timeout});
    const diffCount = await previewDialog.locator('.diff-item').count();
    if (diffCount < 1) throw new Error('配置版本详情没有显示与当前配置的差异');
    const restoreButton = previewDialog.getByRole('button', {name: '恢复此版本', exact: true});
    if (await restoreButton.isDisabled()) throw new Error('存在差异时恢复按钮仍不可用');
    await page.waitForTimeout(250);
    report.screenshots.push(await screenshot(page, 'settings-config-version-preview.png'));
    await restoreButton.click();
    const restoreConfirm = page.locator('.el-message-box:visible');
    await restoreConfirm.waitFor({state: 'visible', timeout});
    await restoreConfirm.getByRole('button', {name: '恢复', exact: true}).click();
    await previewDialog.waitFor({state: 'hidden', timeout});

    await page.locator('button[data-section="settings-general"]').click();
    const targetInput = page.locator(targetLanguageSelector);
    await targetInput.waitFor({state: 'visible', timeout});
    await page.waitForFunction(
      ({selector, expected}) => document.querySelector(selector)
        ?.closest('.el-select__wrapper')
        ?.querySelector('.el-select__placeholder')
        ?.textContent?.trim() === expected,
      {selector: targetLanguageSelector, expected: targetChange.before},
      {timeout},
    );

    // 配置版本恢复按设计会回到旧快照，所以在该用例之后创建 profile，再把它继续
    // 带过完整备份、精确恢复和页面重载，覆盖目录、配置、凭据与持久化整条链路。
    await page.locator('button[data-section="settings-services"]').click();
    await serviceCatalog.waitFor({state: 'visible', timeout});
    await customServiceAdd.click();
    const customServiceDialog = page.getByTestId('custom-service-dialog');
    await customServiceDialog.waitFor({state: 'visible', timeout});
    await customServiceDialog.getByTestId('custom-service-save').click();
    if (await customServiceDialog.getByRole('alert').count() !== 3) {
      throw new Error('自定义服务空表单没有同时校验名称、接口和模型');
    }
    await customServiceDialog.getByTestId('custom-service-name').fill(customServiceFixture.name);
    await customServiceDialog.getByTestId('custom-service-endpoint').fill(customServiceFixture.endpoint);
    await customServiceDialog.getByTestId('custom-service-api-key').fill(customServiceFixture.apiKey);
    await customServiceDialog.getByTestId('custom-service-model').fill(customServiceFixture.model);
    await customServiceDialog.getByTestId('custom-service-save').click();
    await customServiceDialog.waitFor({state: 'hidden', timeout});
    const customServiceItem = customServiceGroup.locator('.service-item[data-custom-service-id^="custom:"]');
    await customServiceItem.waitFor({state: 'visible', timeout});
    customServiceId = await customServiceItem.getAttribute('data-custom-service-id');
    if (!customServiceId?.startsWith('custom:')) throw new Error(`自定义服务没有稳定动态 ID：${customServiceId}`);
    if ((await customServiceCount.textContent())?.trim() !== '1 / 20') {
      throw new Error(`创建后的自定义服务计数异常：${await customServiceCount.textContent()}`);
    }
    const customServiceDescriptionLayout = await customServiceItem.evaluate(item => {
      const card = item.getBoundingClientRect();
      const copy = item.querySelector('.service-copy')?.getBoundingClientRect();
      const description = item.querySelector('.service-copy small');
      const descriptionRect = description?.getBoundingClientRect();
      const descriptionStyle = description ? getComputedStyle(description) : null;
      return {
        cardRight: card.right,
        copyRight: copy?.right ?? null,
        descriptionRight: descriptionRect?.right ?? null,
        descriptionWidth: descriptionRect?.width ?? null,
        descriptionScrollWidth: description?.scrollWidth ?? null,
        overflow: descriptionStyle?.overflow ?? '',
        textOverflow: descriptionStyle?.textOverflow ?? '',
        whiteSpace: descriptionStyle?.whiteSpace ?? '',
      };
    });
    if (customServiceDescriptionLayout.descriptionRight === null
      || customServiceDescriptionLayout.descriptionRight > customServiceDescriptionLayout.cardRight + 1
      || customServiceDescriptionLayout.descriptionRight > (customServiceDescriptionLayout.copyRight ?? Infinity) + 1
      || customServiceDescriptionLayout.overflow !== 'hidden'
      || customServiceDescriptionLayout.textOverflow !== 'ellipsis'
      || customServiceDescriptionLayout.whiteSpace !== 'nowrap') {
      throw new Error(`自定义服务接口地址超出卡片边界：${JSON.stringify(customServiceDescriptionLayout)}`);
    }
    report.informationArchitecture.serviceCatalogHierarchy.customServiceDescription = customServiceDescriptionLayout;
    report.assertions.customServiceDescriptionBounded = true;
    if (await customServiceItem.getAttribute('aria-pressed') !== 'true'
      || await serviceCatalog.getAttribute('data-editing-service') !== customServiceId
      || await serviceCatalog.getAttribute('data-default-service') !== defaultServiceMetrics.defaultService) {
      throw new Error('新建自定义服务没有成为当前配置项，或误改了默认服务');
    }
    if (await serviceCatalog.getByLabel('自定义服务名称').inputValue() !== customServiceFixture.name
      || await serviceCatalog.getByLabel('自定义服务接口地址').inputValue() !== customServiceFixture.endpoint
      || !(await serviceCatalog.getByTestId('model-picker-trigger').getAttribute('aria-label'))
        ?.includes(customServiceFixture.model)
      || await serviceCatalog.locator('.credential-field input[type="password"]').inputValue()
        !== customServiceFixture.apiKey) {
      throw new Error('新建自定义服务的名称、接口、模型或 API Key 没有进入详情配置');
    }
    const advancedSettings = serviceCatalog.getByTestId('custom-service-advanced');
    const currentThinkingSwitch = advancedSettings.getByRole('switch', {
      name: '当前模型是否启用 Thinking',
      includeHidden: true,
    });
    if (await advancedSettings.getAttribute('open') !== null) {
      throw new Error('新建自定义服务时高级设置没有保持默认折叠');
    }
    if (await currentThinkingSwitch.getAttribute('aria-checked') !== 'false') {
      throw new Error('新建模型的 Thinking 没有保持默认关闭');
    }
    const currentThinkingControl = currentThinkingSwitch.locator('..');
    if (await currentThinkingControl.isVisible()) throw new Error('模型 Thinking 没有默认收纳在高级设置中');
    await advancedSettings.locator('summary').click();
    if (!await currentThinkingControl.isVisible()) throw new Error('当前模型 Thinking 开关没有可见的交互控件');
    await currentThinkingControl.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前模型是否启用 Thinking"]')
      ?.getAttribute('aria-checked') === 'true', undefined, {timeout});

    await serviceCatalog.getByTestId('model-picker-trigger').click();
    let modelPickerPanel = page.locator('.model-picker-popper:visible');
    await modelPickerPanel.getByTestId('add-custom-model').click();
    await modelPickerPanel.getByTestId('custom-model-input').fill(customServiceFixture.secondModel);
    await modelPickerPanel.getByTestId('custom-model-submit').click();
    await page.waitForFunction(model => document.querySelector('[data-testid="model-picker-trigger"]')
      ?.getAttribute('aria-label')?.includes(model), customServiceFixture.secondModel, {timeout});
    if (await currentThinkingSwitch.getAttribute('aria-checked') !== 'false') {
      throw new Error('新增的第二个模型错误继承了第一个模型的 Thinking');
    }

    if (await page.locator('.model-picker-popper:visible').count() === 0) {
      await serviceCatalog.getByTestId('model-picker-trigger').click();
    }
    modelPickerPanel = page.locator('.model-picker-popper:visible');
    await modelPickerPanel.locator(`[data-model-id="${customServiceFixture.model}"] .model-picker-option`).click();
    await page.waitForFunction(model => {
      const trigger = document.querySelector('[data-testid="model-picker-trigger"]');
      const toggle = document.querySelector('[aria-label="当前模型是否启用 Thinking"]');
      return trigger?.getAttribute('aria-label')?.includes(model)
        && toggle?.getAttribute('aria-checked') === 'true';
    }, customServiceFixture.model, {timeout});
    report.screenshots.push(await screenshot(page, 'settings-custom-service-thinking.png'));

    await serviceCatalog.getByTestId('model-picker-trigger').click();
    modelPickerPanel = page.locator('.model-picker-popper:visible');
    await modelPickerPanel.locator(`[data-model-id="${customServiceFixture.secondModel}"] .model-picker-option`).click();
    await page.waitForFunction(model => {
      const trigger = document.querySelector('[data-testid="model-picker-trigger"]');
      const toggle = document.querySelector('[aria-label="当前模型是否启用 Thinking"]');
      return trigger?.getAttribute('aria-label')?.includes(model)
        && toggle?.getAttribute('aria-checked') === 'false';
    }, customServiceFixture.secondModel, {timeout});
    await page.waitForTimeout(500);
    report.assertions.modelThinkingPerModel = true;
    report.assertions.modelThinkingInAdvancedSettings = true;
    await page.waitForTimeout(500);
    report.informationArchitecture.serviceCatalogHierarchy.customService = {
      dynamicId: true,
      count: 1,
      defaultServiceUnchanged: true,
      endpointPersisted: true,
      model: customServiceFixture.model,
    };
    report.screenshots.push(await screenshot(page, 'settings-custom-service-created.png'));

    const vocabularyBackupFixture = await seedVocabularyBackupFixture(page);
    await page.locator('button[data-section="settings-data"]').click();
    const transferActionLabels = (await page.locator('#settings-data .transfer-actions button').allTextContents())
      .map(label => label.trim());
    if (JSON.stringify(transferActionLabels) !== JSON.stringify(['导出备份', '从备份恢复'])) {
      throw new Error(`完整备份区不是唯一的导出/恢复两个入口：${JSON.stringify(transferActionLabels)}`);
    }
    if (await page.getByTestId('persist-credentials-switch').count()) {
      throw new Error('备份与恢复页仍显示已废弃的凭据持久化开关');
    }
    if ((await page.locator('#settings-data').textContent()).includes('跨浏览器重启保存 API 凭据')) {
      throw new Error('备份与恢复页仍显示已废弃的凭据持久化文案');
    }

    const initialDownload = await downloadCompleteBackup(page, false);
    const exportedBackup = initialDownload.backup;
    assertCompleteBackupEnvelope(exportedBackup, legacyMigrationSentinels, {
      minimumVocabularyEntries: 1,
      minimumModelUsageEvents: modelUsageFixture.eventCount,
      expectPrivateContext: false,
      privateContextSentinels: vocabularyBackupFixture.privateContext,
    });
    const exportedConfig = exportedBackup.config;
    const exportedCustomProvider = exportedConfig.customOpenAIProviders
      ?.find(provider => provider.id === customServiceId);
    if (exportedCustomProvider?.name !== customServiceFixture.name
      || exportedCustomProvider.endpoint !== customServiceFixture.endpoint
      || !exportedCustomProvider.models?.includes(customServiceFixture.model)
      || !exportedCustomProvider.models?.includes(customServiceFixture.secondModel)
      || exportedConfig.modelThinking?.[customServiceId]?.[customServiceFixture.model] !== true
      || exportedConfig.modelThinking?.[customServiceId]?.[customServiceFixture.secondModel] !== false
      || exportedConfig.token?.[customServiceId] !== customServiceFixture.apiKey) {
      throw new Error('首次完整备份没有包含动态自定义服务、模型 Thinking 及其凭据');
    }
    report.completeBackup = {
      contextChoice: 'exclude-private-context',
      initialDownload: {
        suggestedFilename: initialDownload.suggestedFilename,
        format: exportedBackup.format,
        version: exportedBackup.version,
        configCredentialMode: exportedBackup.configCredentialMode,
        vocabularyEntries: exportedBackup.vocabulary.entries.length,
        vocabularyReviewLogs: exportedBackup.vocabulary.reviewLogs.length,
        modelUsageEvents: exportedBackup.modelUsage.events.length,
        privateVocabularyContextExcluded: true,
        credentialsIncluded: true,
      },
    };

    const sentinels = {
      token: 'indexeddb-openai-token-sensitive-sentinel',
      ak: 'indexeddb-ak-sensitive-sentinel',
      sk: 'indexeddb-sk-sensitive-sentinel',
      appid: 'indexeddb-appid-sensitive-sentinel',
      key: 'indexeddb-key-sensitive-sentinel',
      youdaoAppKey: 'indexeddb-youdao-app-key-sensitive-sentinel',
      youdaoAppSecret: 'indexeddb-youdao-app-secret-sensitive-sentinel',
      tencentSecretId: 'indexeddb-tencent-secret-id-sensitive-sentinel',
      tencentSecretKey: 'indexeddb-tencent-secret-key-sensitive-sentinel',
      extra: 'indexeddb-extra-sensitive-sentinel',
      userRole: 'indexeddb-user-role-sensitive-sentinel {{text}}',
      systemRole: 'indexeddb-system-role-sensitive-sentinel',
      proxy: 'https://indexeddb-proxy-sensitive-sentinel.invalid/v1',
      customBody: '{"indexedDbProof":"indexeddb-custom-body-sensitive-sentinel"}',
    };
    const importedConfig = {
      ...exportedConfig,
      to: exportedConfig.to === 'en' ? 'ja' : 'en',
      token: {...exportedConfig.token, openai: sentinels.token},
      ak: sentinels.ak,
      sk: sentinels.sk,
      appid: sentinels.appid,
      key: sentinels.key,
      youdaoAppKey: sentinels.youdaoAppKey,
      youdaoAppSecret: sentinels.youdaoAppSecret,
      tencentSecretId: sentinels.tencentSecretId,
      tencentSecretKey: sentinels.tencentSecretKey,
      extra: {...exportedConfig.extra, indexedDbProof: sentinels.extra},
      user_role: {...exportedConfig.user_role, openai: sentinels.userRole},
      system_role: {...exportedConfig.system_role, openai: sentinels.systemRole},
      proxy: {...exportedConfig.proxy, openai: sentinels.proxy},
      customBody: {...exportedConfig.customBody, openai: sentinels.customBody},
    };
    const importedBackup = {
      ...exportedBackup,
      exportedAt: Date.now(),
      config: importedConfig,
    };
    await page.getByRole('button', {name: '从备份恢复', exact: true}).click();
    const restoreSourceDialog = page.getByTestId('restore-source-dialog');
    await restoreSourceDialog.waitFor({state: 'visible', timeout});
    await restoreSourceDialog.getByText('选择备份文件', {exact: true}).waitFor({state: 'visible', timeout});
    await restoreSourceDialog.getByText('粘贴旧版配置 JSON', {exact: true}).waitFor({state: 'visible', timeout});
    const fileChooserPromise = page.waitForEvent('filechooser', {timeout});
    await restoreSourceDialog.getByRole('button', {name: '选择文件', exact: true}).click();
    const fileChooser = await fileChooserPromise;
    const importFileName = 'fluentread-backup-browser-round-trip.json';
    await fileChooser.setFiles({
      name: importFileName,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(importedBackup)),
    });
    const localDataImportDialog = page.getByTestId('local-data-import-dialog');
    await localDataImportDialog.waitFor({state: 'visible', timeout});
    await localDataImportDialog.getByText('FluentRead 备份', {exact: true}).waitFor({state: 'visible', timeout});
    await localDataImportDialog.getByText(importFileName, {exact: true}).waitFor({state: 'visible', timeout});
    for (const sectionLabel of ['设置与凭据', '单词本', '模型用量']) {
      await localDataImportDialog.getByText(sectionLabel, {exact: true}).first().waitFor({state: 'visible', timeout});
    }
    await localDataImportDialog.locator('.config-change-group h4')
      .filter({hasText: /^凭据安全/u})
      .waitFor({state: 'visible', timeout});
    if (await localDataImportDialog.locator('.config-change-list article').count() < 1) {
      throw new Error('完整备份导入预览没有显示配置或凭据变化');
    }
    await localDataImportDialog.getByText('OpenAI API Key', {exact: true}).waitFor({state: 'visible', timeout});
    await localDataImportDialog.getByText('将替换（内容已隐藏）', {exact: true}).first().waitFor({state: 'visible', timeout});
    const importPreviewText = await localDataImportDialog.textContent();
    const hiddenCredentialSentinels = [
      sentinels.token,
      sentinels.ak,
      sentinels.sk,
      sentinels.appid,
      sentinels.key,
      sentinels.youdaoAppKey,
      sentinels.youdaoAppSecret,
      sentinels.tencentSecretId,
      sentinels.tencentSecretKey,
      sentinels.extra,
    ];
    for (const sentinel of hiddenCredentialSentinels) {
      if (importPreviewText.includes(sentinel)) throw new Error(`完整备份导入预览泄露凭据内容：${sentinel}`);
    }
    if (!importPreviewText.includes(sentinels.proxy)) {
      throw new Error('完整备份导入预览没有展示作为普通设置管理的代理地址变化');
    }
    report.screenshots.push(await screenshot(page, 'settings-complete-backup-import-preview.png'));
    await localDataImportDialog.getByRole('button', {name: '确认导入', exact: true}).click();
    await localDataImportDialog.waitFor({state: 'hidden', timeout});
    await page.locator('.el-message:visible').filter({hasText: '导入完成'}).waitFor({state: 'visible', timeout});

    await page.locator('button[data-section="settings-general"]').click();
    await page.waitForFunction(
      ({selector, expected}) => document.querySelector(selector)
        ?.closest('.el-select__wrapper')
        ?.querySelector('.el-select__placeholder')
        ?.textContent?.trim() === expected,
      {
        selector: targetLanguageSelector,
        expected: importedConfig.to === 'en' ? 'English / 英语' : '日本語 / Japanese / 日语',
      },
      {timeout},
    );
    await page.locator('button[data-section="settings-data"]').click();

    report.encryptedConfigurationStorage = await inspectEncryptedConfigurationStorage(page, sentinels);
    report.assertions.indexedDbEncryptedAtRest = true;
    report.assertions.legacyConfigStorageCleared = true;

    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await page.locator('.settings-app').waitFor({state: 'visible', timeout});
    await page.locator('button[data-section="settings-data"]').click();
    const reloadedDownload = await downloadCompleteBackup(page, false);
    const reloadedBackup = reloadedDownload.backup;
    assertCompleteBackupEnvelope(reloadedBackup, sentinels, {
      minimumVocabularyEntries: exportedBackup.vocabulary.entries.length,
      minimumModelUsageEvents: exportedBackup.modelUsage.events.length,
      expectPrivateContext: false,
      privateContextSentinels: vocabularyBackupFixture.privateContext,
    });
    const reloadedExportConfig = reloadedBackup.config;
    if (reloadedExportConfig.to !== importedConfig.to) throw new Error('页面重载后目标语言没有从加密 IndexedDB 恢复');
    const reloadedCustomProvider = reloadedExportConfig.customOpenAIProviders
      ?.find(provider => provider.id === customServiceId);
    if (reloadedCustomProvider?.name !== customServiceFixture.name
      || reloadedCustomProvider.endpoint !== customServiceFixture.endpoint
      || !reloadedCustomProvider.models?.includes(customServiceFixture.model)
      || !reloadedCustomProvider.models?.includes(customServiceFixture.secondModel)
      || reloadedExportConfig.modelThinking?.[customServiceId]?.[customServiceFixture.model] !== true
      || reloadedExportConfig.modelThinking?.[customServiceId]?.[customServiceFixture.secondModel] !== false
      || reloadedExportConfig.token?.[customServiceId] !== customServiceFixture.apiKey) {
      throw new Error('动态自定义服务及模型 Thinking 没有完整经过备份精确恢复、加密存储和页面重载');
    }
    report.reloadedCompleteBackup = {
      suggestedFilename: reloadedDownload.suggestedFilename,
      format: reloadedBackup.format,
      version: reloadedBackup.version,
      targetLanguage: reloadedExportConfig.to,
      credentialFields: [
        'token', 'ak', 'sk', 'appid', 'key', 'youdaoAppKey', 'youdaoAppSecret',
        'tencentSecretId', 'tencentSecretKey', 'extra',
      ],
      roleFields: ['user_role', 'system_role'],
      vocabularyEntries: reloadedBackup.vocabulary.entries.length,
      modelUsageEvents: reloadedBackup.modelUsage.events.length,
      customOpenAIServiceRoundTrip: true,
      encryptedStorageRoundTrip: true,
    };
    report.completeBackup.restore = {
      source: 'file-chooser',
      fileName: importFileName,
      credentialPreviewHidden: true,
      confirmed: true,
    };
    report.assertions.encryptedConfigReloadRoundTrip = true;
    report.assertions.settingHistoryAndAutomaticSnapshots = true;
    report.assertions.settingSnapshotPreviewBeforeRestore = true;
    report.assertions.settingSnapshotRestoreWithConfirmation = true;
    report.assertions.completeBackupOnlyTwoTransferActions = true;
    report.assertions.completeBackupDownload = true;
    report.assertions.completeBackupEnvelope = true;
    report.assertions.completeBackupContextConfirmation = true;
    report.assertions.completeBackupImportPreview = true;
    report.assertions.completeBackupFileRestore = true;

    for (const viewport of [
      {width: 1366, height: 700},
      {width: 1024, height: 900},
      {width: 820, height: 900},
      {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('button[data-section="settings-general"]').click();
      await page.waitForTimeout(150);
      const serviceCardLayout = await defaultServiceCard.evaluate(card => {
        const item = card.closest('.settings-item');
        const cardRect = card.getBoundingClientRect();
        const itemRect = item?.getBoundingClientRect();
        const copyRect = item?.querySelector('.settings-item-copy')?.getBoundingClientRect();
        return {
          withinViewport: Boolean(itemRect && itemRect.left >= -1 && itemRect.right <= window.innerWidth + 1),
          stacked: Boolean(copyRect && cardRect.top >= copyRect.bottom - 1),
          controlWidth: cardRect.width,
        };
      });
      if (!serviceCardLayout.withinViewport) throw new Error(`${viewport.width}px 默认服务卡超出视口`);
      if (viewport.width <= 480 && !serviceCardLayout.stacked) throw new Error(`${viewport.width}px 默认服务设置行没有纵向排列`);
      const generalMetrics = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        sectionWithinViewport: [...document.querySelectorAll('.settings-section')]
          .filter(section => getComputedStyle(section).display !== 'none')
          .every(section => {
            const rect = section.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= window.innerWidth + 1;
          }),
        activeNavigationVisible: (() => {
          const active = document.querySelector('nav[aria-label="设置分类"] button[aria-current="page"]');
          if (!active) return false;
          const rect = active.getBoundingClientRect();
          return rect.left >= -1
            && rect.right <= window.innerWidth + 1
            && rect.top >= -1
            && rect.bottom <= window.innerHeight + 1;
        })(),
      }));
      if (generalMetrics.horizontalOverflow
        || !generalMetrics.sectionWithinViewport
        || !generalMetrics.activeNavigationVisible) {
        throw new Error(`${viewport.width}px 通用设置响应式异常：${JSON.stringify(generalMetrics)}`);
      }
      const generalFile = `settings-general-${viewport.width}.png`;
      report.screenshots.push(await screenshot(page, generalFile));
      report.defaultServiceCard.responsive.push({...viewport, ...serviceCardLayout});
      report.responsive.push({page: 'settings-general', ...viewport, ...generalMetrics});

      await page.locator('button[data-section="settings-translation"]').click();
      await page.waitForTimeout(150);
      const translationMetrics = await page.evaluate(expectedGroups => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        groupOrder: [...document.querySelectorAll('.settings-section')]
          .filter(section => getComputedStyle(section).display !== 'none')
          .flatMap(section => [...section.querySelectorAll('.settings-group-heading h2')])
          .map(heading => heading.textContent?.trim()),
        groupsWithinViewport: [...document.querySelectorAll('.settings-section')]
          .filter(section => getComputedStyle(section).display !== 'none')
          .flatMap(section => [...section.querySelectorAll('.settings-group')])
          .every(group => {
            const rect = group.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= window.innerWidth + 1;
          }),
        expectedOrder: JSON.stringify(expectedGroups),
        activeNavigationVisible: (() => {
          const active = document.querySelector('nav[aria-label="设置分类"] button[aria-current="page"]');
          if (!active) return false;
          const rect = active.getBoundingClientRect();
          return rect.left >= -1
            && rect.right <= window.innerWidth + 1
            && rect.top >= -1
            && rect.bottom <= window.innerHeight + 1;
        })(),
      }), expectedTranslationGroups);
      if (translationMetrics.horizontalOverflow
        || !translationMetrics.groupsWithinViewport
        || !translationMetrics.activeNavigationVisible
        || JSON.stringify(translationMetrics.groupOrder) !== translationMetrics.expectedOrder) {
        throw new Error(`${viewport.width}px 翻译设置响应式异常：${JSON.stringify(translationMetrics)}`);
      }
      const translationFile = `settings-translation-${viewport.width}.png`;
      report.screenshots.push(await screenshot(page, translationFile));
      report.responsive.push({page: 'settings-translation', ...viewport, ...translationMetrics});

      await page.locator('button[data-section="settings-interface"]').click();
      await page.waitForTimeout(150);
      const loadingStyleMetrics = await page.evaluate(() => {
        const picker = document.querySelector('.loading-style-picker');
        const pickerRect = picker?.getBoundingClientRect();
        const cards = [...(picker?.querySelectorAll('.loading-style-option') || [])];
        const cardRects = cards.map(card => card.getBoundingClientRect());
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          pickerWithinViewport: Boolean(pickerRect
            && pickerRect.left >= -1
            && pickerRect.right <= window.innerWidth + 1),
          cardsWithinPicker: Boolean(pickerRect && cardRects.every(rect => (
            rect.left >= pickerRect.left - 1 && rect.right <= pickerRect.right + 1
          ))),
          optionCount: cards.length,
          columnCount: new Set(cardRects.map(rect => Math.round(rect.left))).size,
          activeNavigationVisible: (() => {
            const active = document.querySelector('nav[aria-label="设置分类"] button[aria-current="page"]');
            if (!active) return false;
            const rect = active.getBoundingClientRect();
            return rect.left >= -1
              && rect.right <= window.innerWidth + 1
              && rect.top >= -1
              && rect.bottom <= window.innerHeight + 1;
          })(),
        };
      });
      if (loadingStyleMetrics.horizontalOverflow
        || !loadingStyleMetrics.pickerWithinViewport
        || !loadingStyleMetrics.cardsWithinPicker
        || !loadingStyleMetrics.activeNavigationVisible
        || loadingStyleMetrics.optionCount !== 15
        || (viewport.width <= 480 && loadingStyleMetrics.columnCount > 2)) {
        throw new Error(`${viewport.width}px 段落加载样式响应式异常：${JSON.stringify(loadingStyleMetrics)}`);
      }
      const loadingStyleFile = `settings-interface-loading-styles-${viewport.width}.png`;
      report.screenshots.push(await screenshot(page, loadingStyleFile));
      report.responsive.push({page: 'settings-interface-loading-styles', ...viewport, ...loadingStyleMetrics});

      await page.locator('button[data-section="settings-model-usage"]').click();
      await page.waitForTimeout(150);
      const usageMetrics = await page.evaluate(() => {
        const dashboard = document.querySelector('#settings-model-usage');
        const toolbar = dashboard?.querySelector('.usage-toolbar');
        const trend = dashboard?.querySelector('.usage-trend-plot');
        const dashboardRect = dashboard?.getBoundingClientRect();
        const toolbarRect = toolbar?.getBoundingClientRect();
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          dashboardWithinViewport: Boolean(dashboardRect
            && dashboardRect.left >= -1
            && dashboardRect.right <= window.innerWidth + 1),
          toolbarWithinDashboard: Boolean(dashboardRect && toolbarRect
            && toolbarRect.left >= dashboardRect.left - 1
            && toolbarRect.right <= dashboardRect.right + 1),
          trendOverflow: trend ? trend.scrollWidth > trend.clientWidth + 1 : false,
          providerFilterVisible: Boolean(dashboard?.querySelector('[aria-label="模型用量服务"]')?.getClientRects().length),
          modelFilterVisible: Boolean(dashboard?.querySelector('[aria-label="模型用量模型"]')?.getClientRects().length),
        };
      });
      if (usageMetrics.horizontalOverflow
        || !usageMetrics.dashboardWithinViewport
        || !usageMetrics.toolbarWithinDashboard
        || usageMetrics.trendOverflow
        || !usageMetrics.providerFilterVisible
        || !usageMetrics.modelFilterVisible) {
        throw new Error(`${viewport.width}px 模型用量响应式异常：${JSON.stringify(usageMetrics)}`);
      }
      const usageFile = `settings-model-usage-${viewport.width}.png`;
      report.screenshots.push(await screenshot(page, usageFile));
      report.responsive.push({page: 'settings-model-usage', ...viewport, ...usageMetrics});
    }
    await page.getByRole('button', {name: '清除统计', exact: true}).click();
    const finalResetDialog = page.getByRole('alertdialog', {name: '清除本机模型用量？'});
    await finalResetDialog.waitFor({state: 'visible', timeout});
    report.screenshots.push(await screenshot(page, 'settings-model-usage-reset-confirmation.png'));
    await finalResetDialog.getByRole('button', {name: '确认清除统计', exact: true}).click();
    await finalResetDialog.waitFor({state: 'hidden', timeout});
    await page.getByText('还没有模型调用记录', {exact: true}).waitFor({state: 'visible', timeout});
    const remainingUsageEvents = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('FluentReadModelUsage');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const request = database.transaction('events', 'readonly').objectStore('events').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    });
    if (remainingUsageEvents !== 0) throw new Error(`确认清除后仍有 ${remainingUsageEvents} 条模型用量事件`);
    report.modelUsage.resetConfirmed = true;
    report.modelUsage.remainingEvents = remainingUsageEvents;
    report.assertions.modelUsageReset = true;
    report.screenshots.push(await screenshot(page, 'settings-model-usage-empty-after-reset.png'));
    report.assertions.responsive = true;
    await assertTestBrowserRemainsBackground(context, '设置中心测试完成');
    report.assertions.reusedPopupStayedBackground = true;
    if (errors.length) throw new Error(`浏览器控制台存在错误：${errors.join(' | ')}`);
    report.ok = true;
  } catch (error) {
    report.failure = error instanceof Error ? {message: error.message, stack: error.stack} : {message: String(error)};
    if (/测试 Edge 进程 \d+ 成为了前台应用/u.test(report.failure.message)) {
      report.focusSafetyFailure = true;
      // helper在抛错前保留上次成功快照；报告要记录失败事实，不能把旧 false 当作本轮结论。
      if (report.windowPlacement) report.windowPlacement.browserFrontmost = true;
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close();
    fs.rmSync(profileDir, {recursive: true, force: true});
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
