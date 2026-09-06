#!/usr/bin/env node

// 这个脚本只使用临时 Edge profile 和真实 Alt+T / Control 键盘手势，回归全文翻译的
// 识别、按钮特殊处理、富文本结构、动态节点、Shadow DOM、0ms 连续悬浮、
// 普通 hover 触发的同源 DOM 换代、取消后的组合键隔离、同值属性写入稳定性以及恢复流程。
// 传入 --verify-floating-ui 时，还会从 closed Shadow DOM 读取悬浮球透明度、
// 展开/收起、中间 Logo 点击稳定性、勾选标记几何与离屏任务下的进度面板显隐。
// 它不会连接用户正在使用的浏览器 profile，也不会通过 JS 合成键盘事件。

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const FAILURE_ACTION_LINK_SELECTOR = '#translation-error-link';
const FAILURE_ACTION_TEXT_MARKER = 'This block link fails once';
const configurationPages = new WeakMap();

function parseArgs(argv) {
  const args = {
    url: null,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    background: true,
    timeout: 120000,
    // 当前 main 的默认服务是“免费翻译服务”，内部按微软、DeepLX、谷歌顺序回退；
    // --service 只用于断言已预置的隔离 profile 配置，不会偷偷修改服务选择。
    service: 'freeTranslation',
    // 仅在本次临时 profile 中写入服务，便于把“回退服务慢”和“全文机制问题”分开。
    // 不传此参数时，脚本不会修改任何配置。
    configureService: null,
    focusSafeHelper: null,
    verifyFloatingUi: false,
    verifyLoadingStyleIsolation: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--background') continue;
    if (token === '--headed') {
      args.background = false;
      continue;
    }
    if (token === '--verify-floating-ui') {
      args.verifyFloatingUi = true;
      continue;
    }
    if (token === '--verify-loading-style-isolation') {
      args.verifyLoadingStyleIsolation = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值：${token}`);
    args[key] = value;
    index += 1;
  }
  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('--timeout 必须为正数');
  if (!args.extensionDir) throw new Error('必须传入 --extension-dir');
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root');
  if (args.service !== 'freeTranslation' || (args.configureService && args.configureService !== 'freeTranslation')) {
    throw new Error('全文本地 fixture 只允许 freeTranslation；真实 provider 必须使用显式 network matrix');
  }
  if (args.url) {
    const url = new URL(args.url);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('全文本地 fixture 只允许 loopback URL；真实站点必须使用显式 network matrix');
    }
  }
  if (args.background && !args.focusSafeHelper) {
    throw new Error('后台模式必须传入 --focus-safe-helper，确保真实浏览器不抢占前台焦点');
  }
  if (args.focusSafeHelper) args.focusSafeHelper = path.resolve(args.focusSafeHelper);
  return args;
}

function createFixtureRequestHandler(html) {
  return (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/unified-translation-fixture.html') {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  };
}

function buildFixtureMicrosoftResponseBody(payload) {
  const texts = Array.isArray(payload) ? payload.map((value) => String(value)) : [];
  return JSON.stringify(texts.map((text) => ({
    translations: [{text: `测试译文：${text}`}],
  })));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startTranslationFixtureServer(unexpectedNetworkRequests = [], responseDelayMs = 0) {
  let requestCount = 0;
  let translatedItemCount = 0;
  const requestPayloads = [];
  let failureActionAttempts = 0;
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'POST' && requestUrl.pathname === '/translate') {
      let payload = [];
      try {
        payload = JSON.parse(await readRequestBody(request));
      } catch {
        payload = [];
      }
      requestCount += 1;
      translatedItemCount += Array.isArray(payload) ? payload.length : 0;
      requestPayloads.push(Array.isArray(payload) ? [...payload] : []);
      if (responseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      }
      const matchesFailureActionLink = Array.isArray(payload) && payload.some((text) =>
        String(text).includes(FAILURE_ACTION_TEXT_MARKER));
      if (matchesFailureActionLink) {
        failureActionAttempts += 1;
        if (failureActionAttempts === 1) {
          response.writeHead(400, {
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(JSON.stringify({error: 'fixture link fails on its first translation attempt'}));
          return;
        }
      }
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(buildFixtureMicrosoftResponseBody(payload));
      return;
    }
    if (requestUrl.pathname === '/blocked') {
      unexpectedNetworkRequests.push(requestUrl.searchParams.get('url') || 'unknown');
      response.writeHead(502, {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('External network is disabled in the full-page fixture');
      return;
    }
    response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    response.end('Not found');
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('无法取得全文翻译响应 fixture server 地址');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    translationUrl: `${baseUrl}/translate`,
    blockedUrl: `${baseUrl}/blocked`,
    requestCount: () => requestCount,
    translatedItemCount: () => translatedItemCount,
    requestPayloads: () => requestPayloads.map((payload) => [...payload]),
    failureActionAttempts: () => failureActionAttempts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function installTranslationFixtureOnWorker(worker, fixtureUrls) {
  await worker.evaluate(({translationUrl, blockedUrl}) => {
    if (globalThis.__fluentReadFullPageFixtureFetchInstalled) return;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const parsedUrl = new URL(requestUrl);
      const isMicrosoftTranslation = parsedUrl.hostname === 'edge.microsoft.com'
        && parsedUrl.pathname === '/translate/translatetext';
      if (isMicrosoftTranslation) {
        const redirectedInput = typeof Request !== 'undefined' && input instanceof Request
          ? new Request(translationUrl, input)
          : translationUrl;
        return nativeFetch(redirectedInput, init);
      }
      if ((parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
          && !['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname)) {
        return nativeFetch(`${blockedUrl}?url=${encodeURIComponent(requestUrl)}`, {method: 'GET'});
      }
      return nativeFetch(input, init);
    };
    globalThis.__fluentReadFullPageFixtureFetchInstalled = true;
  }, fixtureUrls);
}

function assertNoRuntimeErrors(runtimeErrors) {
  if (runtimeErrors.length > 0) {
    throw new Error(`全文翻译浏览器回归出现运行时错误：${JSON.stringify(runtimeErrors)}`);
  }
}

function assertDeterministicFixtureTraffic(fixtureTranslationRequestCount, unexpectedNetworkRequests) {
  if (fixtureTranslationRequestCount <= 0) {
    throw new Error('全文本地 fixture 未命中确定性微软翻译路由');
  }
  if (unexpectedNetworkRequests.length > 0) {
    throw new Error(`全文本地 fixture 尝试访问未授权网络：${JSON.stringify(unexpectedNetworkRequests)}`);
  }
}

const HOSTILE_LOADING_INDICATOR_CSS = `
@keyframes spin { to { transform: rotate(13deg) scale(8); } }
@keyframes fluent-read-loading-sparkle { to { opacity: 0; transform: scale(8); } }
span.fluent-read-loading,
span.fluent-read-loading.static {
  all: revert !important;
  position: fixed !important;
  inset: 24px !important;
  display: block !important;
  float: right !important;
  width: 144px !important;
  min-width: 144px !important;
  max-width: 144px !important;
  height: 96px !important;
  min-height: 96px !important;
  max-height: 96px !important;
  margin: 48px !important;
  padding: 28px !important;
  border: 18px solid red !important;
  opacity: .08 !important;
  visibility: hidden !important;
  color: red !important;
  background: yellow !important;
  transform: rotate(33deg) scale(6) !important;
  animation: spin 10s linear infinite !important;
}
span.fluent-read-loading::before,
span.fluent-read-loading::after {
  content: "HOST PAGE" !important;
  display: block !important;
  position: fixed !important;
  width: 240px !important;
  height: 120px !important;
  background: red !important;
}
`;

const LATE_HOSTILE_LOADING_INDICATOR_CSS = `
span.fluent-read-loading[data-fr-translation-owned="true"] {
  all: unset !important;
  display: grid !important;
  width: 220px !important;
  height: 180px !important;
  margin: 72px !important;
  padding: 36px !important;
  border: 24px dotted blue !important;
  opacity: 0 !important;
  visibility: collapse !important;
  transform: translate(500px, 500px) !important;
  animation: fluent-read-loading-sparkle 20s infinite !important;
}
span.fluent-read-loading::before,
span.fluent-read-loading::after {
  content: "LATE PAGE OVERRIDE" !important;
  display: flex !important;
}
`;

async function addHostileLoadingIndicatorCss(page, id, css) {
  await page.evaluate(({styleId, styleText}) => {
    const targets = [document.head, document.querySelector('#shadow-host')?.shadowRoot].filter(Boolean);
    for (const target of targets) {
      const stylesheet = document.createElement('style');
      stylesheet.id = styleId;
      stylesheet.textContent = styleText;
      target.appendChild(stylesheet);
    }
  }, {styleId: id, styleText: css});
}

async function readLoadingStyleIsolationState(page, selector = '.fluent-read-loading', shadowHostSelector = null) {
  return page.evaluate(({targetSelector, targetShadowHostSelector}) => {
    const root = targetShadowHostSelector
      ? document.querySelector(targetShadowHostSelector)?.shadowRoot
      : document;
    const host = root?.querySelector(targetSelector);
    if (!(host instanceof HTMLElement)) return null;
    const rect = host.getBoundingClientRect();
    const computed = getComputedStyle(host);
    const before = getComputedStyle(host, '::before');
    const after = getComputedStyle(host, '::after');
    const importantProperties = [
      'all', 'display', 'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
      'margin', 'padding', 'border', 'opacity', 'visibility', 'transform', 'animation',
    ];
    return {
      loadingStyle: host.getAttribute('data-fr-loading-style'),
      motion: host.getAttribute('data-fr-motion'),
      owned: host.getAttribute('data-fr-translation-owned'),
      translate: host.getAttribute('translate'),
      className: host.className,
      shadowRootClosed: host.shadowRoot === null,
      lightChildCount: host.childElementCount,
      rect: {width: rect.width, height: rect.height},
      computed: {
        display: computed.display,
        width: computed.width,
        height: computed.height,
        marginLeft: computed.marginLeft,
        padding: computed.padding,
        borderWidth: computed.borderWidth,
        opacity: computed.opacity,
        visibility: computed.visibility,
        transform: computed.transform,
        animationName: computed.animationName,
      },
      pseudo: {
        before: {content: before.content, display: before.display},
        after: {content: after.content, display: after.display},
      },
      inlinePriorities: Object.fromEntries(importantProperties.map((property) => [
        property,
        host.style.getPropertyPriority(property),
      ])),
    };
  }, {targetSelector: selector, targetShadowHostSelector: shadowHostSelector});
}

function assertLoadingStyleIsolation(state, phase, expectedMotion = 'animated') {
  if (!state) throw new Error(`${phase} 没有找到翻译加载指示器`);
  const issues = [];
  if (state.loadingStyle !== 'sparkle') issues.push(`样式=${state.loadingStyle}`);
  if (state.motion !== expectedMotion) issues.push(`动画状态=${state.motion}`);
  if (state.owned !== 'true') issues.push(`owned=${state.owned}`);
  if (state.translate !== 'no') issues.push(`translate=${state.translate}`);
  if (state.className !== 'fluent-read-loading') issues.push(`class=${state.className}`);
  if (!state.shadowRootClosed || state.lightChildCount !== 0) issues.push('内部视觉没有保持 closed ShadowRoot');
  if (Math.abs(state.rect.width - 16) > .25 || Math.abs(state.rect.height - 16) > .25) {
    issues.push(`几何=${state.rect.width}x${state.rect.height}`);
  }
  if (state.computed.display !== 'inline-flex' || state.computed.width !== '16px' || state.computed.height !== '16px') {
    issues.push(`布局=${JSON.stringify(state.computed)}`);
  }
  if (state.computed.marginLeft !== '2px' || state.computed.padding !== '0px' || state.computed.borderWidth !== '0px') {
    issues.push(`盒模型=${JSON.stringify(state.computed)}`);
  }
  if (state.computed.opacity !== '1' || state.computed.visibility !== 'visible' ||
      state.computed.transform !== 'none' || state.computed.animationName !== 'none') {
    issues.push(`宿主表现=${JSON.stringify(state.computed)}`);
  }
  if (!['none', 'normal'].includes(state.pseudo.before.content) || state.pseudo.before.display !== 'none' ||
      !['none', 'normal'].includes(state.pseudo.after.content) || state.pseudo.after.display !== 'none') {
    issues.push(`伪元素=${JSON.stringify(state.pseudo)}`);
  }
  const weakPriorities = Object.entries(state.inlinePriorities).filter(([, priority]) => priority !== 'important');
  if (weakPriorities.length > 0) issues.push(`非 important 属性=${JSON.stringify(weakPriorities)}`);
  if (issues.length > 0) {
    throw new Error(`${phase} 页面样式影响了翻译加载指示器：${issues.join('；')}；${JSON.stringify(state)}`);
  }
}

async function startFixtureServer() {
  const fixturePath = path.resolve(__dirname, '../tests/fixtures/unified-translation-fixture.html');
  const html = fs.readFileSync(fixturePath);
  const server = http.createServer(createFixtureRequestHandler(html));
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('无法取得全文翻译 fixture server 地址');
  }
  return {
    url: `http://127.0.0.1:${address.port}/unified-translation-fixture.html`,
    isListening: () => server.listening,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function loadPlaywright(root) {
  try {
    return require('playwright');
  } catch {
    const resolvedRoot = path.resolve(root);
    const loader = createRequire(path.join(resolvedRoot, '__fluentread_full_page_loader__.cjs'));
    return loader('playwright');
  }
}

function loadFocusSafeBrowser(helperPath) {
  if (!helperPath) throw new Error('必须传入 --focus-safe-helper，确保真实浏览器在后台隔离运行');
  if (!fs.existsSync(helperPath)) throw new Error(`找不到后台浏览器辅助脚本：${helperPath}`);
  const helper = require(helperPath);
  for (const name of ['launchFocusSafePersistentContext', 'newPageWithoutForeground', 'activateExtensionTabWithoutForeground']) {
    if (typeof helper[name] !== 'function') throw new Error(`后台浏览器辅助脚本缺少接口：${name}`);
  }
  return helper;
}

function assertDedicatedProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
  ];
  if (forbidden.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) {
    throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
  }
}

async function waitFor(page, predicate, timeout, description) {
  await page.waitForFunction(predicate, undefined, { timeout });
  if (description) return description;
}

async function getConfigurationPage(context, createPage) {
  const existing = configurationPages.get(context);
  if (existing && !existing.isClosed()) return existing;
  const page = await createPage();
  configurationPages.set(context, page);
  return page;
}

async function readConfig(context, timeout, updates = null, createPage = () => context.newPage()) {
  const workers = context.serviceWorkers();
  const worker = workers[0] || await context.waitForEvent('serviceworker', { timeout: Math.min(timeout, 30000) });
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) throw new Error('没有找到扩展 service worker');
  // 反复关闭配置页可能让 macOS Edge 提升剩余窗口；同一隔离上下文复用一页，
  // 由浏览器 finally 一并清理，全部创建/激活仍经过 focus-safe helper。
  const popup = await getConfigurationPage(context, createPage);
  try {
    await popup.goto(`chrome-extension://${match[1]}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const config = await popup.evaluate(async ({configUpdates, timeoutMs}) => {
      const parseRecord = (value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        if (typeof value !== 'string') return {};
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      };
      const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || '扩展后台消息失败'));
            return;
          }
          resolve(response);
        });
      });
      const readConfigRecord = async (key) => {
        const response = await sendRuntimeMessage({type: 'configStorageRead', key});
        if (response?.success !== true) throw new Error(response?.error || `后台配置读取失败：${key}`);
        return response.value ?? null;
      };
      const readCompleteConfig = async () => {
        const [storedConfig, localCredentials, sessionCredentials] = await Promise.all([
          readConfigRecord('local:config'),
          readConfigRecord('local:credentials'),
          readConfigRecord('session:credentials'),
        ]);
        const publicConfig = parseRecord(storedConfig);
        const credentialRecord = localCredentials && typeof localCredentials === 'object'
          ? localCredentials
          : sessionCredentials && typeof sessionCredentials === 'object'
            ? sessionCredentials
            : null;
        const credentials = credentialRecord ? {...credentialRecord} : {};
        delete credentials.schemaVersion;
        return {
          config: {...publicConfig, ...credentials},
          revision: publicConfig.__fluentConfigRevision,
        };
      };

      let current = await readCompleteConfig();
      if (!configUpdates || Object.keys(configUpdates).length === 0) return current.config;
      if (!Number.isSafeInteger(current.revision) || current.revision < 0) {
        throw new Error('后台配置没有有效 revision');
      }

      const clientId = `full-page-fixture:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      let response;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const nextConfig = {...current.config, ...configUpdates};
        for (const key of Object.keys(nextConfig)) {
          if (key.startsWith('__fluentConfig')) delete nextConfig[key];
        }
        response = await sendRuntimeMessage({
          type: 'persistConfig',
          config: nextConfig,
          clientId,
          sequence: attempt,
          baseRevision: current.revision,
        });
        if (response?.success === true) break;
        if (!String(response?.error || '').includes('配置已更新') || attempt === 3) {
          throw new Error(response?.error || '后台拒绝保存全文测试配置');
        }
        current = await readCompleteConfig();
        if (!Number.isSafeInteger(current.revision) || current.revision < 0) {
          throw new Error('配置冲突重试时后台 revision 无效');
        }
      }
      if (response?.success !== true || !Number.isSafeInteger(response.revision) || response.revision < 0) {
        throw new Error('后台没有确认全文测试配置写入');
      }

      const deadline = Date.now() + Math.min(timeoutMs, 10_000);
      do {
        current = await readCompleteConfig();
        const updatesApplied = Object.entries(configUpdates).every(([key, value]) => (
          JSON.stringify(current.config[key]) === JSON.stringify(value)
        ));
        if (current.revision >= response.revision && updatesApplied) return current.config;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error('全文测试配置没有通过后台协议持久化');
    }, {configUpdates: updates, timeoutMs: timeout});
    return { extensionId: match[1], config };
  } catch (error) {
    configurationPages.delete(context);
    throw error;
  }
}

async function toggleFullPage(page, activatePage) {
  await activatePage(page);
  // 使用 Playwright 的真实 Alt/T 键序列，对应插件默认全文快捷键 Alt+T。
  await page.keyboard.down('Alt');
  await page.keyboard.press('t');
  await page.keyboard.up('Alt');
}

async function toggleHoverTranslation(page, selector, activatePage) {
  await activatePage(page);
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`悬浮翻译目标不可见：${selector}`);
  }
  // 链接本身绝不能为了“激活页面”而先点击。只移动真实指针，再发送可信 Control 手势。
  // 先离开目标、再分步移入并等待 :hover，避免连续后台 fixture 切换时 CDP 鼠标位置
  // 尚未进入内容脚本而把 Control 手势落到上一个坐标。
  await page.mouse.move(0, 0);
  await page.mouse.move(
    box.x + Math.min(16, box.width / 2),
    box.y + Math.min(14, box.height / 2),
    {steps: 4},
  );
  await page.waitForFunction((targetSelector) => (
    document.querySelector(targetSelector)?.matches(':hover') === true
  ), selector, {timeout: 5000});
  await page.waitForTimeout(50);
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
}

function assertCancelledHoverStages(evidence) {
  if (evidence.stages.length !== 3 || evidence.stages.some((stage) =>
    stage.requests !== evidence.initialRequests || stage.wrapperCount !== 0 || !stage.htmlStable)) {
    throw new Error(`已取消的悬浮组合键重新触发翻译：${JSON.stringify(evidence)}`);
  }
}

function assertCancelledHoverGesture(evidence) {
  assertCancelledHoverStages(evidence);
  if (evidence.freshGesture.wrapperCount !== 1 || evidence.freshGesture.neighborCount !== 0 ||
      evidence.restored.wrapperCount !== 0 || !evidence.restored.htmlStable ||
      evidence.urlBefore !== evidence.urlAfter) {
    throw new Error(`释放全部按键后的新悬浮手势没有正常恢复：${JSON.stringify(evidence)}`);
  }
}

async function verifyCancelledHoverGesture(page, activatePage, translationFixtureServer, timeout) {
  await activatePage(page);
  const selectors = ['#paragraph-one', '#paragraph-two'];
  const originalHtml = await page.evaluate((targets) => targets.map((selector) =>
    document.querySelector(selector)?.innerHTML), selectors);
  const urlBefore = page.url();
  const initialRequests = translationFixtureServer.requestCount();
  const readStage = async (phase) => ({
    phase,
    requests: translationFixtureServer.requestCount(),
    ...await page.evaluate(({targets, html}) => ({
      wrapperCount: targets.reduce((count, selector) => count +
        (document.querySelector(selector)?.querySelectorAll('.fluent-read-bilingual-content').length || 0), 0),
      htmlStable: targets.every((selector, index) => document.querySelector(selector)?.innerHTML === html[index]),
    }), {targets: selectors, html: originalHtml}),
  });
  const moveAcrossTargets = async () => {
    for (const selector of selectors) {
      const box = await page.locator(selector).boundingBox();
      if (!box) throw new Error(`已取消悬浮手势的目标不可见：${selector}`);
      await page.mouse.move(box.x + 20, box.y + 12, {steps: 3});
      await page.waitForTimeout(100);
    }
  };
  const stages = [];
  await page.mouse.move(0, 0);
  await page.keyboard.down('Control');
  try {
    await page.keyboard.down('c');
    try {
      await moveAcrossTargets();
      stages.push(await readStage('Control+C held'));
    } finally {
      await page.keyboard.up('c');
    }
    await moveAcrossTargets();
    stages.push(await readStage('C released, Control held'));
  } finally {
    await page.keyboard.up('Control');
  }
  await page.waitForTimeout(200);
  stages.push(await readStage('all keys released'));
  assertCancelledHoverStages({initialRequests, stages});

  // 下一轮新的可信手势必须恢复正常，避免以永久关闭悬浮来掩盖取消缺陷。
  await toggleHoverTranslation(page, '#paragraph-two', activatePage);
  await page.waitForFunction(() => document.querySelectorAll(
    '#paragraph-two > .fluent-read-bilingual-content').length === 1, undefined, {timeout});
  const freshGesture = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('#paragraph-two > .fluent-read-bilingual-content').length,
    neighborCount: document.querySelectorAll('#paragraph-one .fluent-read-bilingual-content').length,
  }));
  await toggleHoverTranslation(page, '#paragraph-two', activatePage);
  await page.waitForFunction(() => !document.querySelector('#paragraph-two .fluent-read-bilingual-content'),
    undefined, {timeout});
  const restored = await readStage('restored after fresh gesture');
  const evidence = {initialRequests, stages, freshGesture, restored, urlBefore, urlAfter: page.url()};
  assertCancelledHoverGesture(evidence);
  return evidence;
}

function assertUnchangedAttributeStability(evidence) {
  if (evidence.beforeRequests !== evidence.afterRequests || evidence.paintFrames < 18 ||
      evidence.targets.length !== 2 || evidence.targets.some((target) =>
        !target.sameOwner || !target.sameSlots || !target.htmlStable || target.domMutations !== 0 ||
        target.invalidPaintFrames !== 0 || target.maxGeometryDelta > 0.5)) {
    throw new Error(`同值属性写入重建了已完成的单译文或控件：${JSON.stringify(evidence)}`);
  }
}

function assertSingleSourceProtection(evidence) {
  if (evidence.beforeSlots !== 2 || evidence.afterSlots !== 1 || evidence.protectedSlots !== 0 ||
      !evidence.protectedSourcePreserved || !evidence.sameProtectedSource || !evidence.remainingTranslated ||
      evidence.loadingCount !== 0 || evidence.retryCount !== 0) {
    throw new Error(`仅译文的后代保护边界变化没有重建正确来源：${JSON.stringify(evidence)}`);
  }
}

function assertSingleCloneRestoration(evidence) {
  if (!evidence.sameOwner || !evidence.sourceTextPreserved || !evidence.sameClonedSource ||
      !evidence.rebuiltSlot || !evidence.translated || evidence.slotCount !== 1 ||
      !evidence.restoredTextPreserved || !evidence.restoredClonedSource || evidence.restoredSlotCount !== 0) {
    throw new Error(`仅译文宿主克隆丢失原文或无法恢复：${JSON.stringify(evidence)}`);
  }
}

async function verifyUnchangedAttributeStability({
  page, context, args, createIsolatedPage, activateTestPage, translationFixtureServer, artifactsDir,
}) {
  const selectors = ['#paragraph-two', '#save-button'];
  await page.evaluate(() => {
    const owner = document.createElement('p');
    owner.id = 'single-source-protection-target';
    owner.innerHTML = '<span id="single-protected-source">This named source region will become protected.</span> The remaining source must keep its translation.';
    document.querySelector('main').prepend(owner);
    window.__fluentReadSourceProtection = {
      source: owner.querySelector('span').firstChild,
      text: owner.querySelector('span').textContent,
    };
    const cloneOwner = document.createElement('p');
    cloneOwner.id = 'single-clone-target';
    cloneOwner.textContent = 'Host clones of translated markup must preserve every source word.';
    owner.after(cloneOwner);
  });
  await page.evaluate((targets) => targets.forEach((selector) => {
    const owner = document.querySelector(selector);
    owner.setAttribute('title', 'Stable host tooltip');
    owner.setAttribute('lang', 'en');
  }), selectors);
  await readConfig(context, args.timeout, {display: 0}, createIsolatedPage);
  try {
    await toggleFullPage(page, activateTestPage);
    await page.waitForFunction(() => document.querySelector('#paragraph-two .fluent-read-single-slot') &&
      /[\u3400-\u9fff]/u.test(document.querySelector('#save-button')?.textContent || ''),
    undefined, {timeout: args.timeout});
    await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
    const beforeRequests = translationFixtureServer.requestCount();
    const sample = await page.evaluate(async (targets) => {
      const records = targets.map((selector) => {
        const owner = document.querySelector(selector);
        const slots = Array.from(owner.querySelectorAll('.fluent-read-single-slot'));
        const record = {selector, owner, slots, html: owner.innerHTML, rect: owner.getBoundingClientRect(),
          domMutations: 0, invalidPaintFrames: 0, maxGeometryDelta: 0};
        record.observer = new MutationObserver((mutations) => { record.domMutations += mutations.length; });
        record.observer.observe(owner, {childList: true, subtree: true, characterData: true});
        return record;
      });
      let paintFrames = 0;
      for (let index = 0; index < 24; index += 1) {
        for (const record of records) {
          record.owner.setAttribute('title', 'Stable host tooltip');
          record.owner.setAttribute('lang', 'en');
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        paintFrames += 1;
        for (const record of records) {
          const current = document.querySelector(record.selector);
          const rect = current.getBoundingClientRect();
          record.maxGeometryDelta = Math.max(record.maxGeometryDelta, ...['x', 'y', 'width', 'height']
            .map((key) => Math.abs(rect[key] - record.rect[key])));
          const visible = record.slots.length > 0
            ? record.slots.every((slot) => slot.isConnected && /[\u3400-\u9fff]/u.test(slot.getAttribute('aria-label') || '') &&
              slot.getBoundingClientRect().width > 0 && slot.getBoundingClientRect().height > 0)
            : /[\u3400-\u9fff]/u.test(current.textContent || '');
          if (!visible || current.querySelector('.fluent-read-loading, .fluent-read-retry-wrapper')) {
            record.invalidPaintFrames += 1;
          }
        }
      }
      return {paintFrames, targets: records.map((record) => {
        record.observer.disconnect();
        const current = document.querySelector(record.selector);
        const slots = Array.from(current.querySelectorAll('.fluent-read-single-slot'));
        return {selector: record.selector, sameOwner: current === record.owner,
          sameSlots: slots.length === record.slots.length && slots.every((slot, index) => slot === record.slots[index]),
          htmlStable: current.innerHTML === record.html, domMutations: record.domMutations,
          invalidPaintFrames: record.invalidPaintFrames, maxGeometryDelta: record.maxGeometryDelta,
          singleSlotCount: slots.length};
      })};
    }, selectors);
    const screenshot = artifactsDir ? path.join(artifactsDir, 'full-page-unchanged-attributes-stable.png') : null;
    if (screenshot) await page.screenshot({path: screenshot, fullPage: false});
    const evidence = {beforeRequests, afterRequests: translationFixtureServer.requestCount(), ...sample, screenshot};
    assertUnchangedAttributeStability(evidence);
    await page.waitForFunction(() => document.querySelectorAll(
      '#single-source-protection-target .fluent-read-single-slot').length === 2,
    undefined, {timeout: args.timeout});
    const beforeSlots = await page.locator('#single-source-protection-target .fluent-read-single-slot').count();
    await page.locator('#single-protected-source').evaluate((element) => element.classList.add('notranslate'));
    await page.waitForFunction(() => !document.querySelector('#single-protected-source .fluent-read-single-slot') &&
      document.querySelectorAll('#single-source-protection-target .fluent-read-single-slot').length === 1,
    undefined, {timeout: args.timeout});
    const sourceProtection = {beforeSlots, ...await page.evaluate(() => {
      const owner = document.querySelector('#single-source-protection-target');
      const protectedSource = owner.querySelector('#single-protected-source');
      const slots = owner.querySelectorAll('.fluent-read-single-slot');
      const probe = window.__fluentReadSourceProtection;
      const report = {
        afterSlots: slots.length,
        protectedSlots: protectedSource.querySelectorAll('.fluent-read-single-slot').length,
        protectedSourcePreserved: protectedSource.textContent === probe.text,
        sameProtectedSource: protectedSource.firstChild === probe.source,
        remainingTranslated: /[\u3400-\u9fff]/u.test(slots[0]?.getAttribute('aria-label') || ''),
        loadingCount: owner.querySelectorAll('.fluent-read-loading').length,
        retryCount: owner.querySelectorAll('.fluent-read-retry-wrapper').length,
      };
      delete window.__fluentReadSourceProtection;
      return report;
    })};
    assertSingleSourceProtection(sourceProtection);
    evidence.sourceProtection = sourceProtection;
    await page.waitForFunction(() => document.querySelectorAll(
      '#single-clone-target .fluent-read-single-slot').length === 1, undefined, {timeout: args.timeout});
    await page.evaluate(() => {
      const owner = document.querySelector('#single-clone-target');
      const sourceText = owner.textContent;
      // 模拟框架把已有轻 DOM 序列化回同一个 owner；closed ShadowRoot 不会被复制。
      owner.innerHTML = owner.innerHTML;
      const clonedSlot = owner.querySelector('.fluent-read-single-slot');
      window.__fluentReadSingleClone = {owner, sourceText, clonedSlot, clonedSource: clonedSlot.firstChild};
    });
    await page.waitForFunction(() => {
      const probe = window.__fluentReadSingleClone;
      const slots = probe.owner.querySelectorAll('.fluent-read-single-slot');
      return slots.length === 1 && slots[0] !== probe.clonedSlot &&
        /[\u3400-\u9fff]/u.test(slots[0].getAttribute('aria-label') || '');
    }, undefined, {timeout: args.timeout});
    const singleClone = await page.evaluate(() => {
      const probe = window.__fluentReadSingleClone;
      const owner = document.querySelector('#single-clone-target');
      const slot = owner.querySelector('.fluent-read-single-slot');
      return {sameOwner: owner === probe.owner, sourceTextPreserved: owner.textContent === probe.sourceText,
        sameClonedSource: slot.firstChild === probe.clonedSource, rebuiltSlot: slot !== probe.clonedSlot,
        translated: /[\u3400-\u9fff]/u.test(slot.getAttribute('aria-label') || ''),
        slotCount: owner.querySelectorAll('.fluent-read-single-slot').length};
    });
    await toggleFullPage(page, activateTestPage);
    await page.waitForFunction(() => !document.querySelector('.fluent-read-single-slot, .fluent-read-bilingual-content'),
      undefined, {timeout: args.timeout});
    Object.assign(singleClone, await page.evaluate(() => {
      const probe = window.__fluentReadSingleClone;
      const owner = document.querySelector('#single-clone-target');
      const result = {restoredTextPreserved: owner.textContent === probe.sourceText,
        restoredClonedSource: owner.firstChild === probe.clonedSource,
        restoredSlotCount: owner.querySelectorAll('.fluent-read-single-slot').length};
      delete window.__fluentReadSingleClone;
      return result;
    }));
    assertSingleCloneRestoration(singleClone);
    evidence.singleClone = singleClone;
    return evidence;
  } finally {
    await readConfig(context, args.timeout, {display: 1}, createIsolatedPage);
  }
}

async function verifyZeroDelayHoverStability(page, selector, activatePage, screenshotPath = null) {
  await activatePage(page);
  // 之前的段落手势和 viewport 锚点可能把此段原文留在视口上方，先确保真实命中，
  // 再冻结几何基线；不能把移到负 y 坐标得到的透明背景当成高亮回归。
  await page.locator(selector).scrollIntoViewIfNeeded();
  const initial = await page.evaluate((targetSelector) => {
    const owner = document.querySelector(targetSelector);
    const wrapper = owner?.querySelector(':scope > .fluent-read-bilingual-content');
    const source = owner?.firstChild;
    if (!(owner instanceof HTMLElement) || !(wrapper instanceof HTMLElement) || !source) return null;

    const sourceRange = document.createRange();
    sourceRange.selectNodeContents(source);
    const sourceRect = sourceRange.getBoundingClientRect();
    sourceRange.detach();
    const ownerRect = owner.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const probe = {
      owner,
      wrapper,
      html: owner.innerHTML,
      mutations: 0,
      observer: null,
    };
    probe.observer = new MutationObserver(records => {
      probe.mutations += records.filter(record =>
        record.type === 'childList' || record.type === 'characterData').length;
    });
    probe.observer.observe(owner, {childList: true, subtree: true, characterData: true});
    window.__fluentReadZeroDelayHoverProbe = probe;
    return {
      ownerRect: {
        x: ownerRect.x,
        y: ownerRect.y,
        width: ownerRect.width,
        height: ownerRect.height,
      },
      sourcePoint: {
        x: sourceRect.width > 0 ? sourceRect.x + Math.min(18, sourceRect.width / 2) : ownerRect.x + 12,
        y: sourceRect.height > 0 ? sourceRect.y + sourceRect.height / 2 : ownerRect.y + 10,
      },
      wrapperPoint: {
        x: wrapperRect.x + Math.min(24, wrapperRect.width / 2),
        y: wrapperRect.y + wrapperRect.height / 2,
      },
    };
  }, selector);
  if (!initial) throw new Error(`0ms 连续悬浮目标或译文不存在：${selector}`);

  const readHighlightStyle = () => page.locator(selector).evaluate(owner => {
    const style = getComputedStyle(owner);
    const translation = owner.querySelector(':scope > .fluent-read-bilingual-content');
    const marker = translation ? getComputedStyle(translation, '::before') : null;
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      translationMarker: marker ? {
        content: marker.content,
        width: marker.width,
        backgroundColor: marker.backgroundColor,
      } : null,
    };
  });

  const hoverAcrossSourceAndTranslation = async () => {
    await page.mouse.move(initial.sourcePoint.x, initial.sourcePoint.y, {steps: 4});
    await page.waitForTimeout(80);
    const source = await readHighlightStyle();

    await page.mouse.move(initial.wrapperPoint.x, initial.wrapperPoint.y, {steps: 6});
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.move(
        initial.wrapperPoint.x + (index % 2 === 0 ? 3 : -3),
        initial.wrapperPoint.y + (index % 2 === 0 ? 2 : -2),
      );
      await page.waitForTimeout(25);
    }
    return {source, translation: await readHighlightStyle()};
  };

  await page.mouse.move(0, 0);
  const passiveHighlight = await hoverAcrossSourceAndTranslation();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(80);

  await page.keyboard.down('Control');
  let sourceHighlight;
  let translationHighlight;
  try {
    const continuousHighlight = await hoverAcrossSourceAndTranslation();
    sourceHighlight = continuousHighlight.source;
    translationHighlight = continuousHighlight.translation;
    if (screenshotPath) await page.screenshot({path: screenshotPath, fullPage: false});
  } finally {
    await page.keyboard.up('Control').catch(() => {});
  }
  await page.waitForTimeout(350);

  const final = await page.evaluate((targetSelector) => {
    const probe = window.__fluentReadZeroDelayHoverProbe;
    const owner = document.querySelector(targetSelector);
    const wrapper = owner?.querySelector(':scope > .fluent-read-bilingual-content');
    const ownerRect = owner?.getBoundingClientRect();
    probe?.observer?.disconnect();
    delete window.__fluentReadZeroDelayHoverProbe;
    if (!(owner instanceof HTMLElement) || !(wrapper instanceof HTMLElement) || !ownerRect || !probe) return null;
    return {
      sameOwner: owner === probe.owner,
      sameWrapper: wrapper === probe.wrapper,
      wrapperConnected: probe.wrapper.isConnected,
      wrapperCount: owner.querySelectorAll(':scope > .fluent-read-bilingual-content').length,
      htmlStable: owner.innerHTML === probe.html,
      mutations: probe.mutations,
      ownerRect: {
        x: ownerRect.x,
        y: ownerRect.y,
        width: ownerRect.width,
        height: ownerRect.height,
      },
    };
  }, selector);
  await page.mouse.move(0, 0);
  if (!final) throw new Error(`0ms 连续悬浮结束状态不可读：${selector}`);

  const geometryDelta = Math.max(
    Math.abs(final.ownerRect.x - initial.ownerRect.x),
    Math.abs(final.ownerRect.y - initial.ownerRect.y),
    Math.abs(final.ownerRect.width - initial.ownerRect.width),
    Math.abs(final.ownerRect.height - initial.ownerRect.height),
  );
  const transparent = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  if (!final.sameOwner || !final.sameWrapper || !final.wrapperConnected ||
      final.wrapperCount !== 1 || !final.htmlStable || final.mutations !== 0) {
    throw new Error(`0ms 连续悬浮改变了已译 DOM：${JSON.stringify(final)}`);
  }
  if (geometryDelta > 0.5) {
    throw new Error(`双语高亮改变了段落几何尺寸：${geometryDelta}px`);
  }
  if (!sourceHighlight || !translationHighlight ||
      transparent.has(sourceHighlight.backgroundColor) ||
      sourceHighlight.backgroundColor !== translationHighlight.backgroundColor ||
      sourceHighlight.boxShadow !== translationHighlight.boxShadow ||
      !sourceHighlight.translationMarker ||
      sourceHighlight.translationMarker.content === 'none' ||
      sourceHighlight.translationMarker.width !== '2px' ||
      transparent.has(sourceHighlight.translationMarker.backgroundColor) ||
      JSON.stringify(sourceHighlight.translationMarker) !== JSON.stringify(translationHighlight.translationMarker)) {
    throw new Error(`原文与译文没有触发同一个高亮效果：${JSON.stringify({sourceHighlight, translationHighlight})}`);
  }
  if (transparent.has(passiveHighlight.source.backgroundColor) ||
      passiveHighlight.source.backgroundColor !== passiveHighlight.translation.backgroundColor ||
      passiveHighlight.source.boxShadow !== passiveHighlight.translation.boxShadow ||
      JSON.stringify(passiveHighlight.source.translationMarker) !== JSON.stringify(passiveHighlight.translation.translationMarker) ||
      JSON.stringify(passiveHighlight) !== JSON.stringify({
        source: sourceHighlight,
        translation: translationHighlight,
      })) {
    throw new Error(`普通 hover 与连续翻译手势的高亮效果不一致：${JSON.stringify({passiveHighlight, sourceHighlight, translationHighlight})}`);
  }

  return {
    ...final,
    geometryDelta,
    passiveHighlight,
    sourceHighlight,
    translationHighlight,
    screenshot: screenshotPath,
  };
}

async function verifyPassiveHoverRemountStability(page, selector, activatePage, screenshotPath = null) {
  await activatePage(page);
  await page.waitForFunction((targetSelector) => (
    document.querySelector(targetSelector)
      ?.querySelectorAll(':scope > .fluent-read-bilingual-content[data-fr-translation-owned="true"]')
      .length === 1
  ), selector, {timeout: 10000});

  const initial = await page.evaluate((targetSelector) => {
    const owner = document.querySelector(targetSelector);
    const wrapper = owner?.querySelector(
      ':scope > .fluent-read-bilingual-content[data-fr-translation-owned="true"]',
    );
    const stats = window.__fluentReadHoverRemount;
    if (!(owner instanceof HTMLElement) || !(wrapper instanceof HTMLElement) || !stats) return null;
    stats.armed = true;
    stats.commits = 0;
    stats.sameOwnerCommits = 0;
    stats.wholeOwnerCommits = 0;
    stats.wrapperCloneCommits = 0;
    stats.wrapperClassCommits = 0;
    stats.wrapperTamperCommits = 0;
    stats.wrapperTamperCommitted = false;
    stats.paintFrames = 0;
    stats.sourceOnlyPaintFrames = 0;
    stats.invalidTranslationPaintFrames = 0;
    stats.maxDirectWrappers = 0;
    stats.minTranslationOpacity = 1;
    stats.translationText = wrapper.textContent ?? '';
    const samplePaint = () => {
      if (!stats.armed) return;
      const current = document.querySelector(targetSelector);
      const wrappers = current?.querySelectorAll(
        ':scope > .fluent-read-bilingual-content[data-fr-translation-owned="true"]',
      );
      const directWrappers = wrappers?.length ?? 0;
      const wrapper = wrappers?.[0];
      const style = wrapper ? getComputedStyle(wrapper) : null;
      const opacity = Number.parseFloat(style?.opacity ?? '0');
      const rect = wrapper?.getBoundingClientRect();
      const translationVisible = directWrappers === 1 &&
        wrapper?.textContent === stats.translationText &&
        style?.display !== 'none' && style?.visibility !== 'hidden' &&
        Number.isFinite(opacity) && opacity > 0 && Boolean(rect && rect.width > 0 && rect.height > 0);
      stats.paintFrames += 1;
      stats.maxDirectWrappers = Math.max(stats.maxDirectWrappers, directWrappers);
      if (Number.isFinite(opacity)) stats.minTranslationOpacity = Math.min(stats.minTranslationOpacity, opacity);
      if (directWrappers === 0) stats.sourceOnlyPaintFrames += 1;
      if (!translationVisible) stats.invalidTranslationPaintFrames += 1;
      stats.animationFrame = requestAnimationFrame(samplePaint);
    };
    stats.animationFrame = requestAnimationFrame(samplePaint);
    const rect = owner.getBoundingClientRect();
    return {
      translationText: stats.translationText,
      hostInlineStyle: owner.getAttribute('style'),
      point: {
        x: rect.x + Math.min(36, rect.width / 2),
        y: rect.y + Math.min(18, rect.height / 3),
      },
    };
  }, selector);
  if (!initial) throw new Error(`普通 hover DOM 重挂目标或译文不存在：${selector}`);

  await page.mouse.move(0, 0);
  await page.mouse.move(initial.point.x, initial.point.y, {steps: 1});
  await page.waitForTimeout(24);
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.move(
      initial.point.x + (index % 2 === 0 ? 12 : -12),
      initial.point.y + (index % 3 === 0 ? 5 : -5),
      {steps: 2},
    );
    await page.waitForTimeout(4);
  }
  const highFrequency = await page.evaluate(() => {
    const stats = window.__fluentReadHoverRemount;
    return stats ? {
      commits: stats.commits,
      sameOwnerCommits: stats.sameOwnerCommits,
      wholeOwnerCommits: stats.wholeOwnerCommits,
      wrapperCloneCommits: stats.wrapperCloneCommits,
      wrapperClassCommits: stats.wrapperClassCommits,
      wrapperTamperCommits: stats.wrapperTamperCommits,
      paintFrames: stats.paintFrames,
      sourceOnlyPaintFrames: stats.sourceOnlyPaintFrames,
      invalidTranslationPaintFrames: stats.invalidTranslationPaintFrames,
    } : null;
  });
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.move(
      initial.point.x + (index % 2 === 0 ? -10 : 10),
      initial.point.y + (index % 3 === 0 ? -4 : 4),
      {steps: 2},
    );
    await page.waitForTimeout(24);
  }
  await page.waitForTimeout(250);
  if (screenshotPath) await page.screenshot({path: screenshotPath, fullPage: false});

  const final = await page.evaluate((targetSelector) => {
    const stats = window.__fluentReadHoverRemount;
    const owner = document.querySelector(targetSelector);
    if (!stats || !(owner instanceof HTMLElement)) return null;
    stats.armed = false;
    if (stats.animationFrame) cancelAnimationFrame(stats.animationFrame);
    const wrappers = owner.querySelectorAll(
      ':scope > .fluent-read-bilingual-content[data-fr-translation-owned="true"]',
    );
    return {
      commits: stats.commits,
      sameOwnerCommits: stats.sameOwnerCommits,
      wholeOwnerCommits: stats.wholeOwnerCommits,
      wrapperCloneCommits: stats.wrapperCloneCommits,
      wrapperClassCommits: stats.wrapperClassCommits,
      wrapperTamperCommits: stats.wrapperTamperCommits,
      paintFrames: stats.paintFrames,
      sourceOnlyPaintFrames: stats.sourceOnlyPaintFrames,
      invalidTranslationPaintFrames: stats.invalidTranslationPaintFrames,
      maxDirectWrappers: stats.maxDirectWrappers,
      minTranslationOpacity: stats.minTranslationOpacity,
      wrapperCount: wrappers.length,
      translationText: wrappers[0]?.textContent ?? '',
      loadingCount: owner.querySelectorAll(':scope > .fluent-read-loading').length,
      retryCount: owner.querySelectorAll(':scope > .fluent-read-retry-wrapper').length,
      hostClassOwned: owner.classList.contains('fluent-read-bilingual'),
      hostInlineStyle: owner.getAttribute('style'),
    };
  }, selector);
  await page.mouse.move(0, 0);
  if (!final) throw new Error(`普通 hover DOM 重挂结束状态不可读：${selector}`);
  if (
    final.commits < 30 ||
    final.sameOwnerCommits < 5 ||
    final.wholeOwnerCommits < 5 ||
    final.wrapperCloneCommits < 5 ||
    final.wrapperClassCommits < 5 ||
    final.wrapperTamperCommits !== 1 ||
    final.paintFrames < 1 ||
    final.sourceOnlyPaintFrames !== 0 ||
    final.invalidTranslationPaintFrames !== 0 ||
    final.maxDirectWrappers !== 1 ||
    final.wrapperCount !== 1 ||
    final.translationText !== initial.translationText ||
    final.loadingCount !== 0 ||
    final.retryCount !== 0 ||
    final.hostClassOwned ||
    final.hostInlineStyle !== initial.hostInlineStyle ||
    !highFrequency || highFrequency.commits < 12 ||
    highFrequency.sourceOnlyPaintFrames !== 0 ||
    highFrequency.invalidTranslationPaintFrames !== 0
  ) {
    throw new Error(`普通 hover 的同源 DOM 重挂未保持唯一译文：${JSON.stringify(final)}`);
  }
  return {...final, highFrequency, screenshot: screenshotPath};
}

async function installShortcutDiagnostics(page) {
  await page.evaluate(() => {
    window.__fluentReadFullPageDebug = { keydowns: [], toggleEvents: 0 };
    document.addEventListener('keydown', (event) => {
      window.__fluentReadFullPageDebug.keydowns.push({
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
      });
    });
    document.addEventListener('fluentread-toggle-translation', () => {
      window.__fluentReadFullPageDebug.toggleEvents += 1;
    });
  });
}

async function readShortcutDiagnostics(page) {
  return page.evaluate(() => ({
    debug: window.__fluentReadFullPageDebug || null,
    bilingualCount: document.querySelectorAll('.fluent-read-bilingual-content').length,
    loadingCount: document.querySelectorAll('.fluent-read-loading').length,
    retryCount: document.querySelectorAll('.fluent-read-retry-wrapper').length,
    buttonTexts: {
      save: document.querySelector('#save-button')?.textContent?.trim() || '',
      cancel: document.querySelector('#cancel-button')?.textContent?.trim() || '',
    },
    targetStates: ['#paragraph-one', '#paragraph-two', '#model-description', '#save-button', '#cancel-button']
      .map((selector) => ({
        selector,
        bilingual: document.querySelector(selector)?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
        loading: document.querySelector(selector)?.querySelectorAll('.fluent-read-loading').length || 0,
      })),
    shadowState: (() => {
      const shadow = document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph');
      return { bilingual: shadow?.querySelectorAll('.fluent-read-bilingual-content').length || 0, loading: shadow?.querySelectorAll('.fluent-read-loading').length || 0 };
    })(),
  }));
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

function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

async function computedStyleValues(session, node, names) {
  if (!node) return {};
  const { computedStyle } = await session.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId });
  return Object.fromEntries(computedStyle
    .filter((entry) => names.includes(entry.name))
    .map((entry) => [entry.name, entry.value]));
}

async function nodeBounds(session, node) {
  if (!node) return null;
  try {
    const { model } = await session.send('DOM.getBoxModel', { nodeId: node.nodeId });
    return quadBounds(model.border || model.content);
  } catch {
    return null;
  }
}

async function readFloatingUiState(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const floatingHost = findCdpNode(root, node => cdpAttribute(node, 'id') === 'fluent-read-floating-ball-container');
    const ball = findCdpNode(floatingHost, node => hasCdpClass(node, 'fr-floating-ball'));
    const main = findCdpNode(ball, node => hasCdpClass(node, 'floating-ball-main'));
    const translateTool = findCdpNode(ball, node => hasCdpClass(node, 'floating-ball-translate'));
    const mainCheck = findCdpNode(main, node => node !== main && hasCdpClass(node, 'check-mark'));
    const shortcutTooltip = findCdpNode(ball, node => hasCdpClass(node, 'shortcut-tooltip'));
    const progressHost = findCdpNode(root, node => cdpAttribute(node, 'id') === 'fluent-read-translation-status-container');
    const progressPanel = findCdpNode(progressHost, node => hasCdpClass(node, 'fr-translation-progress'));
    const progressCompactCheck = findCdpNode(progressPanel, node => hasCdpClass(node, 'fr-progress-compact-check'));
    const [mainStyle, toolStyle, mainBox, translateToolBox, checkBox] = await Promise.all([
      computedStyleValues(session, main, ['opacity', 'transform']),
      computedStyleValues(session, translateTool, ['opacity', 'visibility', 'display']),
      nodeBounds(session, main),
      nodeBounds(session, translateTool),
      nodeBounds(session, mainCheck),
    ]);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const checkVisible = Boolean(checkBox &&
      checkBox.right > 0 && checkBox.left < viewport.width &&
      checkBox.bottom > 0 && checkBox.top < viewport.height);
    return {
      host: Boolean(floatingHost),
      ball: Boolean(ball),
      ballClass: cdpAttribute(ball, 'class'),
      ballStyle: cdpAttribute(ball, 'style'),
      position: cdpAttribute(ball, 'data-position'),
      expanded: hasCdpClass(ball, 'floating-ball-expanded'),
      translated: hasCdpClass(ball, 'is-translating'),
      mainOpacity: Number(mainStyle.opacity),
      mainTransform: mainStyle.transform || '',
      mainBox,
      translateToolBox,
      translateToolOpacity: Number(toolStyle.opacity),
      translateToolVisibility: toolStyle.visibility || '',
      translateToolDisplay: toolStyle.display || '',
      check: Boolean(mainCheck),
      checkBox,
      checkVisible,
      shortcutTooltip: Boolean(shortcutTooltip),
      progressHost: Boolean(progressHost),
      progressPanel: Boolean(progressPanel),
      progressPanelClass: cdpAttribute(progressPanel, 'class'),
      progressCompact: hasCdpClass(progressPanel, 'fr-compact'),
      progressCompactCheck: Boolean(progressCompactCheck),
      progress: progressPanel ? {
        running: Number(cdpAttribute(progressPanel, 'data-running')),
        remaining: Number(cdpAttribute(progressPanel, 'data-remaining')),
        queued: Number(cdpAttribute(progressPanel, 'data-queued')),
        offscreen: Number(cdpAttribute(progressPanel, 'data-offscreen')),
      } : null,
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

async function waitForFloatingUiState(page, predicate, timeout, description) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await readFloatingUiState(page);
    if (predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error(`${description}：${JSON.stringify(state)}`);
}

async function assertNoAutomaticFloatingExpansion(page, durationMs = 160) {
  const deadline = Date.now() + durationMs;
  const samples = [];
  do {
    const state = await readFloatingUiState(page);
    samples.push({expanded: state.expanded, translated: state.translated, check: state.check, shortcutTooltip: state.shortcutTooltip});
    if (state.expanded || state.shortcutTooltip) {
      throw new Error(`全文快捷键不应自动展开悬浮球或弹提示：${JSON.stringify({state, samples})}`);
    }
    await page.waitForTimeout(20);
  } while (Date.now() < deadline);
  return samples;
}

function isCollapsedFloatingUiState(state, translated) {
  return Boolean(state.host && state.ball && !state.expanded && state.translated === translated &&
    Math.abs(state.mainOpacity - 0.52) <= 0.03 && state.translateToolOpacity === 0 &&
    state.check === translated && (!translated || state.checkVisible));
}

function assertCollapsedFloatingUi(state, translated, label) {
  if (!isCollapsedFloatingUiState(state, translated)) {
    throw new Error(`${label} 悬浮球没有保持低干扰收起状态：${JSON.stringify(state)}`);
  }
}

function isExpandedFloatingUiState(state) {
  return Boolean(state.expanded && Math.abs(state.mainOpacity - 1) <= 0.01 && state.translateToolOpacity === 1);
}

function assertExpandedFloatingUi(state, label) {
  if (!isExpandedFloatingUiState(state)) {
    throw new Error(`${label} 主动悬停后没有清晰展开：${JSON.stringify(state)}`);
  }
}

async function movePointerToFloatingMain(page, state) {
  const box = state.mainBox;
  if (!box) throw new Error(`无法取得悬浮球几何位置：${JSON.stringify(state)}`);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const visibleLeft = Math.max(1, box.left);
  const visibleRight = Math.min(viewport.width - 1, box.right);
  const visibleTop = Math.max(1, box.top);
  const visibleBottom = Math.min(viewport.height - 1, box.bottom);
  if (visibleLeft >= visibleRight || visibleTop >= visibleBottom) {
    throw new Error(`悬浮球不在可交互视口内：${JSON.stringify({state, viewport})}`);
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 100, y: 100});
    await page.waitForTimeout(30);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: (visibleLeft + visibleRight) / 2,
      y: (visibleTop + visibleBottom) / 2,
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

async function clickFloatingTranslateTool(page, state) {
  const box = state.translateToolBox;
  if (!box) throw new Error(`无法取得全文翻译按钮几何位置：${JSON.stringify(state)}`);
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1});
  } finally {
    await session.detach().catch(() => {});
  }
}

async function clickFloatingMain(page, state) {
  const box = state.mainBox;
  if (!box) throw new Error(`无法取得悬浮球中间 Logo 几何位置：${JSON.stringify(state)}`);
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
    await page.waitForTimeout(30);
    const pressed = await readFloatingUiState(page);
    // 夹带 5px 的真实指针抖动，证明未越过 6px 拖动阈值的普通点击仍保持原位。
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: x + 5, y, button: 'left', buttons: 1});
    await page.waitForTimeout(30);
    const jittered = await readFloatingUiState(page);
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: x + 5, y, button: 'left', buttons: 0, clickCount: 1});
    return {pressed, jittered};
  } finally {
    await session.detach().catch(() => {});
  }
}

async function dragFloatingMain(page, state, targetX) {
  const box = state.mainBox;
  if (!box) throw new Error(`无法取得悬浮球拖动前的几何位置：${JSON.stringify(state)}`);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const visibleLeft = Math.max(1, box.left);
  const visibleRight = Math.min(viewport.width - 1, box.right);
  const visibleTop = Math.max(1, box.top);
  const visibleBottom = Math.min(viewport.height - 1, box.bottom);
  const startX = (visibleLeft + visibleRight) / 2;
  const startY = (visibleTop + visibleBottom) / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: startX, y: startY});
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1});
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: targetX, y: startY, button: 'left', buttons: 1});
    await page.waitForTimeout(50);
    const during = await readFloatingUiState(page);
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: targetX, y: startY, button: 'left', buttons: 0, clickCount: 1});
    return during;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function movePointerAwayFromFloatingUi(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 100, y: 100});
  } finally {
    await session.detach().catch(() => {});
  }
}

function assertFloatingMainClickStable(before, after, beforeUrl, afterUrl) {
  const tolerance = 1;
  const geometryStable = before.mainBox && after.mainBox &&
    ['left', 'top', 'right', 'bottom'].every((key) => Math.abs(before.mainBox[key] - after.mainBox[key]) <= tolerance);
  if (!geometryStable || !before.expanded || !after.expanded || before.position !== after.position ||
      before.translated !== after.translated || before.ballStyle !== after.ballStyle ||
      after.ballClass.includes('dragging') || beforeUrl !== afterUrl) {
    throw new Error(`点击中间 Logo 不应改变悬浮球或页面状态：${JSON.stringify({before, after, beforeUrl, afterUrl})}`);
  }
}

async function readFloatingInteractionDomState(page) {
  return page.evaluate(() => ({
    url: location.href,
    bilingualCount: document.querySelectorAll('.fluent-read-bilingual-content').length,
    loadingCount: document.querySelectorAll('.fluent-read-loading').length,
  }));
}

function assertFloatingInteractionDomStable(before, after, label) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`${label} 不应改变页面译文、加载态或 URL：${JSON.stringify({before, after})}`);
  }
}

function assertFloatingMainDragKeepsPageStable(before, during, after, beforeUrl, afterUrl) {
  const centerY = state => state.mainBox ? (state.mainBox.top + state.mainBox.bottom) / 2 : Number.NaN;
  const centerX = state => state.mainBox ? (state.mainBox.left + state.mainBox.right) / 2 : Number.NaN;
  const verticalStable = Math.abs(centerY(before) - centerY(during)) <= 1 &&
    Math.abs(centerY(before) - centerY(after)) <= 1;
  const horizontalMoved = Math.abs(centerX(before) - centerX(after)) > 100;
  if (before.position === after.position || after.position !== 'left' || before.translated !== after.translated ||
      !during.ballClass.includes('dragging') || after.ballClass.includes('dragging') ||
      !verticalStable || !horizontalMoved || beforeUrl !== afterUrl) {
    throw new Error(`拖动中间 Logo 应平稳地只改变停靠位置：${JSON.stringify({before, during, after, beforeUrl, afterUrl})}`);
  }
}

async function pageState(page) {
  return page.evaluate(() => {
    const get = (selector) => document.querySelector(selector);
    const count = (selector) => get(selector)?.querySelectorAll('.fluent-read-bilingual-content').length || 0;
    const clampState = (clampSelector, targetSelector) => {
      const clamp = get(clampSelector);
      const target = get(targetSelector);
      const wrapper = target?.querySelector('.fluent-read-bilingual-content');
      if (!clamp || !target) return null;
      const clampRect = clamp.getBoundingClientRect();
      const wrapperRect = wrapper?.getBoundingClientRect();
      return {
        bilingual: target.querySelectorAll('.fluent-read-bilingual-content').length,
        lineClamp: getComputedStyle(clamp).webkitLineClamp,
        inlineStyle: clamp.getAttribute('style'),
        clientHeight: clamp.clientHeight,
        scrollHeight: clamp.scrollHeight,
        wrapperVisible: Boolean(wrapperRect && wrapperRect.width > 0 && wrapperRect.height > 0 &&
          wrapperRect.top >= clampRect.top - 1 && wrapperRect.bottom <= clampRect.bottom + 1),
        translationText: wrapper?.textContent?.trim() || '',
      };
    };
    const shadowParagraph = get('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph');
    const button = get('#save-button');
    const cancelButton = get('#cancel-button');
    return {
      paragraphOne: count('#paragraph-one'),
      paragraphTwo: count('#paragraph-two'),
      paragraphTwoText: get('#paragraph-two')?.textContent?.trim() || '',
      heading: count('h1'),
      dynamic: count('#dynamic-paragraph'),
      staticClamp: clampState('#model-description-clamp', '#model-description'),
      dynamicClamp: clampState('#dynamic-model-description-clamp', '#dynamic-paragraph'),
      shadow: shadowParagraph?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
      header: count('header'),
      nav: count('nav'),
      footer: count('footer'),
      buttonBilingualCount: button?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
      buttonText: button?.textContent?.trim() || '',
      cancelButtonText: cancelButton?.textContent?.trim() || '',
      cancelButtonBilingualCount: cancelButton?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
      buttonIconPresent: Boolean(button?.querySelector('[aria-hidden="true"]')),
      codePreserved: Boolean(get('#paragraph-one .fluent-read-bilingual-content code')?.textContent.includes('const value = 42')),
      linkPreserved: get('#paragraph-one .fluent-read-bilingual-content a')?.getAttribute('href') || null,
      iconLigatures: Array.from(document.querySelectorAll('[data-icon-ligature]')).map((element) => element.textContent),
      standaloneIcon: get('#standalone-icon-ligature')?.innerHTML,
      translationContainsIconLigature: /account_circle|keyboard_return/.test(
        get('#paragraph-one .fluent-read-bilingual-content')?.textContent || ''),
    };
  });
}

function assertTranslated(state, label) {
  if (state.paragraphOne !== 1 || state.paragraphTwo !== 1 || state.heading !== 1 || state.dynamic !== 1 || state.shadow !== 1) {
    throw new Error(`${label} 内容块翻译数量不正确：${JSON.stringify(state)}`);
  }
  if (!state.paragraphTwoText.includes('changed after full-page translation')) {
    throw new Error(`${label} 没有响应宿主页面的动态文本更新：${JSON.stringify(state)}`);
  }
  for (const [name, clamp] of [['static', state.staticClamp], ['dynamic', state.dynamicClamp]]) {
    if (!clamp || clamp.bilingual !== 1 || !clamp.wrapperVisible ||
        !/[\u3400-\u9fff]/u.test(clamp.translationText) ||
        !['none', 'unset'].includes(clamp.lineClamp)) {
      throw new Error(`${label} ${name} line-clamp 译文仍被裁剪：${JSON.stringify(clamp)}`);
    }
  }
  if (state.header !== 0 || state.nav !== 0 || state.footer !== 0) throw new Error(`${label} 导航/页脚被误翻译`);
  if (state.buttonBilingualCount !== 0 || state.cancelButtonBilingualCount !== 0 ||
      !/[\u3400-\u9fff]/u.test(state.buttonText) || !/[\u3400-\u9fff]/u.test(state.cancelButtonText) ||
      !state.buttonIconPresent) {
    throw new Error(`${label} 按钮没有按控件规则保留结构并替换文字：${JSON.stringify(state)}`);
  }
  if (!state.codePreserved || !['https://example.com', 'https://example.com/'].includes(state.linkPreserved)) {
    throw new Error(`${label} 富文本结构没有保留：${JSON.stringify(state)}`);
  }
}

function assertRestored(state) {
  if (state.paragraphOne || state.paragraphTwo || state.heading || state.dynamic || state.shadow) {
    throw new Error(`全文恢复后仍残留译文：${JSON.stringify(state)}`);
  }
  if (!state.paragraphTwoText.includes('changed after full-page translation')) {
    throw new Error(`全文恢复覆盖了宿主页面更新：${JSON.stringify(state)}`);
  }
  for (const [name, clamp] of [['static', state.staticClamp], ['dynamic', state.dynamicClamp]]) {
    if (!clamp || clamp.bilingual !== 0 || clamp.lineClamp !== '2' || clamp.inlineStyle !== null) {
      throw new Error(`全文恢复后 ${name} line-clamp 样式没有精确还原：${JSON.stringify(clamp)}`);
    }
  }
  if (state.buttonText !== '★Save changes' || state.cancelButtonText !== 'Cancel' ||
      !state.buttonIconPresent || state.buttonBilingualCount !== 0 || state.cancelButtonBilingualCount !== 0) {
    throw new Error(`按钮恢复不完整：${JSON.stringify(state)}`);
  }
}

async function readFailureActionState(page) {
  return page.evaluate((selector) => {
    const link = document.querySelector(selector);
    const wrapper = link?.querySelector(':scope > .fluent-read-retry-wrapper');
    const retry = wrapper?.querySelector('.fluent-read-retry');
    const reason = wrapper?.querySelector('.fluent-read-reason');
    const retryIcon = retry?.querySelector('.fluent-read-action-icon');
    const reasonIcon = reason?.querySelector('.fluent-read-action-icon');
    const geometry = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const presentation = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        role: element.getAttribute('role') || '',
        tabIndex: element.getAttribute('tabindex'),
        text: element.textContent?.replace(/\s+/gu, ' ').trim() || '',
        display: style.display,
        alignItems: style.alignItems,
        flexWrap: style.flexWrap,
        gap: style.gap,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        cursor: style.cursor,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        pointerEvents: style.pointerEvents,
        textDecorationLine: style.textDecorationLine,
        geometry: geometry(element),
      };
    };
    const noticeHost = document.querySelector('#fluent-read-page-notice-host');
    const notice = noticeHost?.shadowRoot?.querySelector('.page-notice');
    return {
      url: location.href,
      href: link instanceof HTMLAnchorElement ? link.href : '',
      hrefAttribute: link?.getAttribute('href') || '',
      hidden: Boolean(link?.hasAttribute('hidden')),
      linkDisplay: link ? getComputedStyle(link).display : '',
      linkGeometry: geometry(link),
      activations: Number(globalThis.__fluentReadFailureLinkActivations || 0),
      wrapperCount: link?.querySelectorAll(':scope > .fluent-read-retry-wrapper').length || 0,
      translationCount: link?.querySelectorAll(':scope > .fluent-read-bilingual-content').length || 0,
      translationText: link?.querySelector(':scope > .fluent-read-bilingual-content')?.textContent?.trim() || '',
      wrapper: presentation(wrapper),
      retry: presentation(retry),
      reason: presentation(reason),
      retryIcon: presentation(retryIcon),
      reasonIcon: presentation(reasonIcon),
      notice: {
        present: Boolean(notice),
        role: notice?.getAttribute('role') || '',
        detail: notice?.querySelector('.notice-detail')?.textContent?.trim() || '',
      },
    };
  }, FAILURE_ACTION_LINK_SELECTOR);
}

function assertFailureLinkInvariant(state, baseline, phase) {
  if (state.url !== baseline.url || state.href !== baseline.href ||
      state.hrefAttribute !== baseline.hrefAttribute || state.activations !== 0) {
    throw new Error(`${phase} 触发了原链接：${JSON.stringify({baseline, state})}`);
  }
}

function assertFailureActionPresentation(state) {
  const hasArea = (item) => Boolean(item?.geometry && item.geometry.width > 0 && item.geometry.height > 0);
  const isFlexDisplay = (display) => display === 'flex' || display === 'inline-flex';
  const transparent = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
  const issues = [];
  if (state.wrapperCount !== 1 || state.wrapper?.role !== 'group' ||
      !isFlexDisplay(state.wrapper?.display) || state.wrapper?.pointerEvents !== 'auto' ||
      state.wrapper?.flexWrap !== 'wrap' ||
      !hasArea(state.wrapper)) issues.push('wrapper 不可见或不是 inline-flex group');
  for (const [name, action, expectedText] of [
    ['retry', state.retry, '重试'],
    ['reason', state.reason, '错误原因'],
  ]) {
    if (action?.role !== '' || action?.tabIndex !== null || !isFlexDisplay(action?.display) ||
        action?.cursor !== 'pointer' || action?.pointerEvents !== 'auto' ||
        action?.textDecorationLine !== 'none' || action?.text !== expectedText || !hasArea(action) ||
        transparent.has(action?.backgroundColor) || !action?.borderRadius || action.borderRadius === '0px') {
      issues.push(`${name} action 样式或语义无效`);
    }
  }
  for (const [name, icon, action] of [
    ['retry', state.retryIcon, state.retry],
    ['reason', state.reasonIcon, state.reason],
  ]) {
    if (!hasArea(icon) || !hasArea(action) || !isFlexDisplay(icon?.display) ||
        icon.geometry.width > action.geometry.height || icon.geometry.height > action.geometry.height) {
      issues.push(`${name} icon 几何无效`);
    }
  }
  const retryBox = state.retry?.geometry;
  const reasonBox = state.reason?.geometry;
  const wrapperBox = state.wrapper?.geometry;
  const linkBox = state.linkGeometry;
  if (retryBox && reasonBox) {
    const retryCenter = (retryBox.top + retryBox.bottom) / 2;
    const reasonCenter = (reasonBox.top + reasonBox.bottom) / 2;
    if (reasonBox.left < retryBox.right - 0.5 || Math.abs(retryCenter - reasonCenter) > 2) {
      issues.push('两个 action 重叠或未对齐');
    }
  }
  if (wrapperBox && linkBox && (wrapperBox.left < linkBox.left - 1 || wrapperBox.right > linkBox.right + 1 ||
      wrapperBox.top < linkBox.top - 1 || wrapperBox.bottom > linkBox.bottom + 1)) {
    issues.push('失败操作超出链接几何边界');
  }
  if (issues.length > 0) {
    throw new Error(`链接失败操作样式断言失败：${issues.join('；')}；${JSON.stringify(state)}`);
  }
}

async function runFailureActionScenario({
  page,
  context,
  args,
  createIsolatedPage,
  activateTestPage,
  translationFixtureServer,
  artifactsDir,
}) {
  const microsoftConfig = await readConfig(
    context,
    args.timeout,
    {service: 'microsoft'},
    createIsolatedPage,
  );
  if (microsoftConfig.config.service !== 'microsoft') {
    throw new Error(`链接失败 fixture 无法切换到确定性微软服务：${microsoftConfig.config.service}`);
  }
  await page.waitForTimeout(250);
  await page.evaluate((selector) => {
    const link = document.querySelector(selector);
    if (!(link instanceof HTMLAnchorElement)) throw new Error('缺少链接失败 fixture');
    link.hidden = false;
    globalThis.__fluentReadFailureLinkActivations = 0;
  }, FAILURE_ACTION_LINK_SELECTOR);
  await page.waitForSelector(FAILURE_ACTION_LINK_SELECTOR, {state: 'visible', timeout: args.timeout});

  const baseline = await readFailureActionState(page);
  if (baseline.linkDisplay !== 'block' || baseline.hidden || !baseline.href.includes('#translation-error-destination')) {
    throw new Error(`链接失败 fixture 初始状态无效：${JSON.stringify(baseline)}`);
  }

  await toggleHoverTranslation(page, FAILURE_ACTION_LINK_SELECTOR, activateTestPage);
  try {
    await page.waitForSelector(
      `${FAILURE_ACTION_LINK_SELECTOR} > .fluent-read-retry-wrapper`,
      {state: 'visible', timeout: args.timeout},
    );
  } catch (error) {
    const diagnostic = await readFailureActionState(page).catch(() => null);
    throw new Error(`悬浮翻译可信手势未落到预期失败态：${JSON.stringify({
      attempts: translationFixtureServer.failureActionAttempts(),
      diagnostic,
      originalError: error instanceof Error ? error.message : String(error),
    })}`);
  }
  const failed = await readFailureActionState(page);
  assertFailureLinkInvariant(failed, baseline, '首次失败后');
  assertFailureActionPresentation(failed);
  if (translationFixtureServer.failureActionAttempts() !== 1 || failed.translationCount !== 0) {
    throw new Error(`链接没有在首次翻译后进入失败态：${JSON.stringify({
      attempts: translationFixtureServer.failureActionAttempts(),
      failed,
    })}`);
  }

  const screenshots = [];
  if (artifactsDir) {
    const failureScreenshot = path.join(artifactsDir, 'full-page-link-failure.png');
    await page.screenshot({path: failureScreenshot, fullPage: false});
    screenshots.push(failureScreenshot);
  }

  await page.locator(`${FAILURE_ACTION_LINK_SELECTOR} .fluent-read-reason`).click();
  await page.waitForFunction(() => Boolean(
    document.querySelector('#fluent-read-page-notice-host')?.shadowRoot?.querySelector('.page-notice .notice-detail'),
  ), undefined, {timeout: args.timeout});
  const afterReason = await readFailureActionState(page);
  assertFailureLinkInvariant(afterReason, baseline, '点击错误原因后');
  if (!afterReason.notice.present || afterReason.notice.role !== 'alert' || !afterReason.notice.detail) {
    throw new Error(`点击错误原因后没有显示通知：${JSON.stringify(afterReason)}`);
  }
  if (artifactsDir) {
    const reasonScreenshot = path.join(artifactsDir, 'full-page-link-error-reason.png');
    await page.screenshot({path: reasonScreenshot, fullPage: false});
    screenshots.push(reasonScreenshot);
  }

  await page.locator(`${FAILURE_ACTION_LINK_SELECTOR} .fluent-read-retry`).click();
  await page.waitForFunction((selector) => {
    const link = document.querySelector(selector);
    return Boolean(link?.querySelector(':scope > .fluent-read-bilingual-content')) &&
      !link?.querySelector(':scope > .fluent-read-retry-wrapper');
  }, FAILURE_ACTION_LINK_SELECTOR, {timeout: args.timeout});
  const retried = await readFailureActionState(page);
  assertFailureLinkInvariant(retried, baseline, '点击重试成功后');
  if (translationFixtureServer.failureActionAttempts() !== 2 || retried.translationCount !== 1 ||
      !/[\u3400-\u9fff]/u.test(retried.translationText)) {
    throw new Error(`链接手动重试没有在第二次成功：${JSON.stringify({
      attempts: translationFixtureServer.failureActionAttempts(),
      retried,
    })}`);
  }
  if (artifactsDir) {
    const successScreenshot = path.join(artifactsDir, 'full-page-link-retry-success.png');
    await page.screenshot({path: successScreenshot, fullPage: false});
    screenshots.push(successScreenshot);
  }

  await toggleHoverTranslation(page, FAILURE_ACTION_LINK_SELECTOR, activateTestPage);
  await page.waitForFunction((selector) => {
    const link = document.querySelector(selector);
    return Boolean(link) && !link.querySelector('.fluent-read-bilingual-content, .fluent-read-retry-wrapper');
  }, FAILURE_ACTION_LINK_SELECTOR, {timeout: args.timeout});
  const restored = await readFailureActionState(page);
  assertFailureLinkInvariant(restored, baseline, '链接恢复后');
  await page.evaluate((selector) => {
    const link = document.querySelector(selector);
    if (link) link.hidden = true;
  }, FAILURE_ACTION_LINK_SELECTOR);

  const freeConfig = await readConfig(
    context,
    args.timeout,
    {service: 'freeTranslation'},
    createIsolatedPage,
  );
  if (freeConfig.config.service !== 'freeTranslation') {
    throw new Error(`链接失败 fixture 后没有恢复免费翻译服务：${freeConfig.config.service}`);
  }
  await page.waitForTimeout(250);

  return {
    baseline,
    failed,
    afterReason,
    retried,
    restored,
    provider: 'microsoft loopback fail-once',
    attempts: translationFixtureServer.failureActionAttempts(),
    screenshots,
  };
}

// 模拟页面按原文高度定位的 Bootstrap tooltip；双语增高后会覆盖触发图标。
async function verifyTranslatedTooltipHover(page, timeout, artifactsDir) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const trigger = document.createElement('i');
    trigger.id = 'tooltip-hover-trigger';
    trigger.setAttribute('aria-label', 'Information');
    trigger.style.cssText = 'position:fixed;left:600px;top:350px;width:24px;height:24px;z-index:2147483000;background:#ddd';
    document.body.appendChild(trigger);
    window.tooltipHoverCounts = {opens: 0, closes: 0};
    trigger.addEventListener('mouseenter', () => {
      window.tooltipHoverCounts.opens++;
      const tooltip = document.createElement('div');
      tooltip.id = 'translated-hover-tooltip';
      tooltip.className = 'tooltip fade top';
      tooltip.style.cssText = 'position:fixed;left:520px;width:220px;z-index:2147483001;background:white;color:black;padding:8px';
      tooltip.innerHTML = '<div class="tooltip-arrow"></div><div class="tooltip-inner">Set the lowest amount you are happy to receive. You can use suggested amounts to encourage supporters towards your preferred amounts.</div>';
      document.body.appendChild(tooltip);
      tooltip.style.top = `${350 - tooltip.getBoundingClientRect().height - 8}px`;
    });
    trigger.addEventListener('mouseleave', () => {
      window.tooltipHoverCounts.closes++;
      document.querySelector('#translated-hover-tooltip')?.remove();
    });
  });
  const cycles = [];
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.mouse.move(612, 362);
      await page.waitForFunction(() => document.querySelector('#translated-hover-tooltip .fluent-read-bilingual-content'), undefined, {timeout});
      await page.waitForTimeout(1200);
      const state = await page.evaluate(() => {
        const tooltip = document.querySelector('#translated-hover-tooltip');
        const rect = tooltip?.getBoundingClientRect();
        return {...window.tooltipHoverCounts,
          wrappers: tooltip?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
          coversTrigger: Boolean(rect && rect.top < 362 && rect.bottom > 362),
          hit: document.elementFromPoint(612, 362)?.id,
        };
      });
      if (state.opens !== cycle + 1 || state.closes !== cycle || state.wrappers !== 1 ||
          !state.coversTrigger || state.hit !== 'tooltip-hover-trigger') {
        throw new Error(`翻译后 tooltip 抢占鼠标并闪烁：${JSON.stringify(state)}`);
      }
      cycles.push(state);
      if (artifactsDir && cycle === 0) await page.screenshot({path: path.join(artifactsDir, 'tooltip-hover.png')});
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => !document.querySelector('#translated-hover-tooltip'));
    }
    const boundaries = await page.evaluate(() => {
      const results = [];
      for (const [name, attributes, body, expected] of [
        ['aria tooltip', 'role="tooltip"', '', 'none'],
        ['untranslated', 'class="tooltip"', '', 'auto'],
        ['link', 'role="tooltip"', '<a href="#">Help</a>', 'auto'],
        ['button', 'role="tooltip"', '<button>Help</button>', 'auto'],
        ['focusable', 'role="tooltip" tabindex="0"', '', 'auto'],
        ['dialog', 'role="dialog"', '', 'auto'],
        ['ordinary content', '', '', 'auto'],
      ]) {
        const root = document.createElement('div');
        root.innerHTML = `<div ${attributes}><div class="tooltip-inner">Source${body}</div></div>`;
        document.body.appendChild(root);
        const tip = root.firstElementChild;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        if (name !== 'untranslated') tip.firstElementChild.appendChild(wrapper);
        const actual = getComputedStyle(tip).pointerEvents;
        wrapper.remove();
        const restored = getComputedStyle(tip).pointerEvents;
        root.remove();
        results.push({name, expected, actual, restored});
      }
      return results;
    });
    if (boundaries.some(item => item.actual !== item.expected || item.restored !== 'auto')) {
      throw new Error(`tooltip 交互边界失败：${JSON.stringify(boundaries)}`);
    }
    return {cycles, boundaries};
  } catch (error) {
    const counts = await page.evaluate(() => window.tooltipHoverCounts);
    throw new Error(`${error.message}; tooltip lifecycle=${JSON.stringify(counts)}`);
  } finally {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      document.querySelector('#tooltip-hover-trigger')?.remove();
      document.querySelector('#translated-hover-tooltip')?.remove();
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extensionDir = path.resolve(args.extensionDir);
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('插件 manifest.json 不存在');
  if (!fs.existsSync(args.browserPath)) throw new Error(`浏览器不存在：${args.browserPath}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-full-page-'));
  assertDedicatedProfile(profileDir);
  const artifactsDir = args.artifactsDir ? path.resolve(args.artifactsDir) : null;
  if (artifactsDir) fs.mkdirSync(artifactsDir, { recursive: true });
  const { chromium } = loadPlaywright(args.playwrightRoot);
  const focusSafe = args.background ? loadFocusSafeBrowser(args.focusSafeHelper) : null;
  let context;
  let closeBrowser = async () => { if (context) await context.close().catch(() => {}); };
  let createIsolatedPage = () => context.newPage();
  let activateTestPage = async () => undefined;
  let launchMode = args.background ? null : 'playwright-headed';
  let focusPolicy = args.background ? null : 'foreground-authorized';
  let windowPlacement = args.background
    ? null
    : { mode: 'headed-explicit-foreground', windowState: 'normal', viewport: { width: 1280, height: 900 } };
  let fixtureServer = null;
  let translationFixtureServer = null;
  const unexpectedNetworkRequests = [];
  const workerFixtureInstallErrors = [];
  const pendingWorkerFixtureInstalls = new Set();
  try {
    // 默认回归必须自包含；只有显式 --url 才使用调用方提供的页面。
    if (!args.url) {
      fixtureServer = await startFixtureServer();
      args.url = fixtureServer.url;
    }
    const browserArgs = [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (args.background) {
      const browserSession = await focusSafe.launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath: args.browserPath,
        headless: false,
        background: true,
        browserArgs,
        viewport: { width: 1280, height: 900 },
        timeout: args.timeout,
      });
      context = browserSession.context;
      closeBrowser = browserSession.close;
      createIsolatedPage = () => focusSafe.newPageWithoutForeground(context, args.timeout);
      activateTestPage = page => focusSafe.activateExtensionTabWithoutForeground(context, page, args.timeout);
      launchMode = browserSession.launchMode;
      focusPolicy = browserSession.focusPolicy;
      windowPlacement = browserSession.windowPlacement;
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: args.browserPath,
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: browserArgs,
      });
    }
    translationFixtureServer = await startTranslationFixtureServer(
      unexpectedNetworkRequests,
      args.verifyLoadingStyleIsolation ? 1000 : args.verifyFloatingUi ? 400 : 0,
    );
    const fixtureUrls = {
      translationUrl: translationFixtureServer.translationUrl,
      blockedUrl: translationFixtureServer.blockedUrl,
    };
    const scheduleWorkerFixtureInstall = (worker) => {
      if (!worker.url().startsWith('chrome-extension://')) return;
      const pending = installTranslationFixtureOnWorker(worker, fixtureUrls)
        .catch((error) => {
          workerFixtureInstallErrors.push(error.message);
        })
        .finally(() => pendingWorkerFixtureInstalls.delete(pending));
      pendingWorkerFixtureInstalls.add(pending);
    };
    // BrowserContext.route 无法拦截 MV3 service worker 的 fetch，因此把当前 worker
    // 和后续替换 worker 的微软请求直接改写到 loopback 确定性响应。
    context.on('serviceworker', scheduleWorkerFixtureInstall);
    const initialWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', {
        predicate: (worker) => worker.url().startsWith('chrome-extension://'),
        timeout: Math.min(args.timeout, 30000),
      });
    await installTranslationFixtureOnWorker(initialWorker, fixtureUrls);

    // 页面网络仍由 BrowserContext fail-closed；worker 网络则由上面的 fetch 包装器
    // 改写到 /translate 或 /blocked，确保不会泄漏到真实 provider。
    await context.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const isNetworkRequest = requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:';
      const isLoopbackRequest = ['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname);
      if (isNetworkRequest && !isLoopbackRequest) {
        unexpectedNetworkRequests.push(request.url());
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const configUpdates = {
      mouseHoverTranslationDelay: 0,
      bilingualSentenceHighlightEnabled: true,
    };
    if (args.configureService) configUpdates.service = args.configureService;
    if (args.verifyFloatingUi) {
      Object.assign(configUpdates, {
        disableFloatingBall: false,
        translationProgressPanelEnabled: true,
        fullPageTranslationMode: 'viewport',
      });
    }
    if (args.verifyLoadingStyleIsolation) {
      Object.assign(configUpdates, {
        animations: true,
        translationLoadingStyle: 'sparkle',
      });
    }
    if (Object.keys(configUpdates).length > 0) {
      await readConfig(context, args.timeout, configUpdates, createIsolatedPage);
    }
    const page = await createIsolatedPage();
    if (args.verifyLoadingStyleIsolation) {
      await page.emulateMedia({reducedMotion: 'no-preference'});
    }
    const networkEvents = [];
    const runtimeErrors = [];
    let omittedNetworkEvents = 0;
    const recordNetworkEvent = (event) => {
      if (networkEvents.length < 20) networkEvents.push(event);
      else omittedNetworkEvents += 1;
    };
    const recordFailedRequest = (request) => {
      if (/translate|translatetext|deeplx|google/i.test(request.url())) {
        recordNetworkEvent({ type: 'requestfailed', url: request.url(), error: request.failure()?.errorText || 'unknown' });
      }
    };
    const recordResponse = (response) => {
      if (/translate|translatetext|deeplx|google/i.test(response.url())) {
        recordNetworkEvent({ type: 'response', url: response.url(), status: response.status() });
      }
    };
    // 翻译请求由扩展 service worker 发出，BrowserContext 级监听比 page 级更完整。
    context.on('requestfailed', recordFailedRequest);
    context.on('response', recordResponse);
    page.on('requestfailed', recordFailedRequest);
    page.on('response', recordResponse);
    page.on('pageerror', (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text();
        runtimeErrors.push(`console: ${text}`);
        recordNetworkEvent({ type: 'console-error', text });
      }
    });
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
    // 当前 main 默认关闭悬浮球，但悬浮/全文快捷键仍由 content script 独立监听；
    // 不能把“悬浮球是否挂载”当作扩展已加载的判据。
    await page.waitForTimeout(1000);
    const configResult = await readConfig(context, args.timeout, null, createIsolatedPage);
    if (configResult.config?.floatingBallHotkey !== 'Alt+T') throw new Error(`全文快捷键不是 Alt+T：${configResult.config?.floatingBallHotkey}`);
    if (configResult.config?.service !== args.service) throw new Error(`翻译服务不符：预期 ${args.service}，实际 ${configResult.config?.service}`);
    if (configResult.config?.mouseHoverTranslationDelay !== 0 ||
        configResult.config?.bilingualSentenceHighlightEnabled !== true) {
      throw new Error(`0ms 连续悬浮测试配置不正确：${JSON.stringify({
        mouseHoverTranslationDelay: configResult.config?.mouseHoverTranslationDelay,
        bilingualSentenceHighlightEnabled: configResult.config?.bilingualSentenceHighlightEnabled,
      })}`);
    }
    if (args.verifyLoadingStyleIsolation &&
        (configResult.config?.animations !== true || configResult.config?.translationLoadingStyle !== 'sparkle')) {
      throw new Error(`加载样式隔离测试配置不正确：${JSON.stringify({
        animations: configResult.config?.animations,
        translationLoadingStyle: configResult.config?.translationLoadingStyle,
      })}`);
    }
    const floatingUiEvidence = args.verifyFloatingUi ? {} : null;
    let loadingStyleIsolationEvidence = null;
    if (args.verifyLoadingStyleIsolation) {
      await addHostileLoadingIndicatorCss(
        page,
        'hostile-loading-indicator-before',
        HOSTILE_LOADING_INDICATOR_CSS,
      );
    }
    if (args.verifyFloatingUi) {
      if (configResult.config?.disableFloatingBall !== false || configResult.config?.translationProgressPanelEnabled !== true ||
          configResult.config?.fullPageTranslationMode !== 'viewport') {
        throw new Error(`悬浮 UI 测试配置不正确：${JSON.stringify({
          disableFloatingBall: configResult.config?.disableFloatingBall,
          translationProgressPanelEnabled: configResult.config?.translationProgressPanelEnabled,
          fullPageTranslationMode: configResult.config?.fullPageTranslationMode,
        })}`);
      }
      await page.evaluate(() => {
        const fixture = document.createElement('section');
        fixture.id = 'floating-ui-offscreen-fixture';
        for (let index = 0; index < 60; index += 1) {
          const paragraph = document.createElement('p');
          paragraph.id = `floating-ui-offscreen-${index}`;
          paragraph.style.minHeight = '80px';
          paragraph.textContent = `Offscreen paragraph ${index} remains pending until the reader scrolls near this part of the document.`;
          fixture.appendChild(paragraph);
        }
        document.body.appendChild(fixture);
      });
      floatingUiEvidence.initial = await waitForFloatingUiState(
        page,
        state => state.progressHost && isCollapsedFloatingUiState(state, false),
        args.timeout,
        '等待低干扰悬浮球初始状态超时',
      );
      assertCollapsedFloatingUi(floatingUiEvidence.initial, false, '初始');
      await movePointerToFloatingMain(page, floatingUiEvidence.initial);
      await waitForFloatingUiState(
        page,
        state => isExpandedFloatingUiState(state),
        args.timeout,
        '等待中间 Logo 点击前悬浮球展开超时',
      );
      await page.waitForTimeout(520);
      floatingUiEvidence.expandedBeforeMainClick = await readFloatingUiState(page);
      assertExpandedFloatingUi(floatingUiEvidence.expandedBeforeMainClick, '中间 Logo 点击前');
      const urlBeforeMainClick = page.url();
      const requestCountBeforeMainClick = translationFixtureServer.requestCount();
      const domBeforeMainClick = await readFloatingInteractionDomState(page);
      const mainClickStages = await clickFloatingMain(page, floatingUiEvidence.expandedBeforeMainClick);
      floatingUiEvidence.pressedDuringMainClick = mainClickStages.pressed;
      floatingUiEvidence.jitteredDuringMainClick = mainClickStages.jittered;
      assertFloatingMainClickStable(
        floatingUiEvidence.expandedBeforeMainClick,
        floatingUiEvidence.pressedDuringMainClick,
        urlBeforeMainClick,
        page.url(),
      );
      assertFloatingMainClickStable(
        floatingUiEvidence.expandedBeforeMainClick,
        floatingUiEvidence.jitteredDuringMainClick,
        urlBeforeMainClick,
        page.url(),
      );
      await page.waitForTimeout(520);
      floatingUiEvidence.afterMainClick = await readFloatingUiState(page);
      assertFloatingMainClickStable(
        floatingUiEvidence.expandedBeforeMainClick,
        floatingUiEvidence.afterMainClick,
        urlBeforeMainClick,
        page.url(),
      );
      const domAfterMainClick = await readFloatingInteractionDomState(page);
      floatingUiEvidence.mainClickDom = {before: domBeforeMainClick, after: domAfterMainClick};
      assertFloatingInteractionDomStable(domBeforeMainClick, domAfterMainClick, '点击中间 Logo');
      floatingUiEvidence.mainClickTranslationRequests = {
        before: requestCountBeforeMainClick,
        after: translationFixtureServer.requestCount(),
      };
      if (floatingUiEvidence.mainClickTranslationRequests.before !== floatingUiEvidence.mainClickTranslationRequests.after) {
        throw new Error(`点击中间 Logo 不应发起翻译请求：${JSON.stringify(floatingUiEvidence.mainClickTranslationRequests)}`);
      }
      await movePointerAwayFromFloatingUi(page);
      floatingUiEvidence.collapsedAfterMainClick = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, false),
        args.timeout,
        '等待中间 Logo 点击验证后悬浮球收起超时',
      );
      const urlBeforeMainDrag = page.url();
      const requestCountBeforeMainDrag = translationFixtureServer.requestCount();
      const domBeforeMainDrag = await readFloatingInteractionDomState(page);
      floatingUiEvidence.duringMainDrag = await dragFloatingMain(page, floatingUiEvidence.collapsedAfterMainClick, 72);
      await waitForFloatingUiState(
        page,
        state => state.position === 'left' && isCollapsedFloatingUiState(state, false),
        args.timeout,
        '等待中间 Logo 真正拖动后停靠左侧超时',
      );
      await page.waitForTimeout(520);
      floatingUiEvidence.afterMainDrag = await readFloatingUiState(page);
      assertCollapsedFloatingUi(floatingUiEvidence.afterMainDrag, false, '中间 Logo 拖动后');
      assertFloatingMainDragKeepsPageStable(
        floatingUiEvidence.collapsedAfterMainClick,
        floatingUiEvidence.duringMainDrag,
        floatingUiEvidence.afterMainDrag,
        urlBeforeMainDrag,
        page.url(),
      );
      const domAfterMainDrag = await readFloatingInteractionDomState(page);
      floatingUiEvidence.mainDragDom = {before: domBeforeMainDrag, after: domAfterMainDrag};
      assertFloatingInteractionDomStable(domBeforeMainDrag, domAfterMainDrag, '拖动中间 Logo');
      floatingUiEvidence.mainDragTranslationRequests = {
        before: requestCountBeforeMainDrag,
        after: translationFixtureServer.requestCount(),
      };
      if (floatingUiEvidence.mainDragTranslationRequests.before !== floatingUiEvidence.mainDragTranslationRequests.after) {
        throw new Error(`拖动中间 Logo 不应发起翻译请求：${JSON.stringify(floatingUiEvidence.mainDragTranslationRequests)}`);
      }
    }

    const cancelledHoverGesture = await verifyCancelledHoverGesture(
      page, activateTestPage, translationFixtureServer, args.timeout,
    );

    const initialClamp = await page.evaluate(() => {
      const clamp = document.querySelector('#model-description-clamp');
      return clamp ? {
        lineClamp: getComputedStyle(clamp).webkitLineClamp,
        clientHeight: clamp.clientHeight,
        scrollHeight: clamp.scrollHeight,
        inlineStyle: clamp.getAttribute('style'),
      } : null;
    });
    if (!initialClamp || initialClamp.lineClamp !== '2' || initialClamp.inlineStyle !== null ||
        initialClamp.scrollHeight <= initialClamp.clientHeight) {
      throw new Error(`line-clamp fixture 初始状态无效：${JSON.stringify(initialClamp)}`);
    }

    await installShortcutDiagnostics(page);
    await toggleFullPage(page, activateTestPage);
    if (args.verifyLoadingStyleIsolation) {
      await page.waitForFunction(() => Boolean(
        document.querySelector('.fluent-read-loading')
        && document.querySelector('#shadow-host')?.shadowRoot?.querySelector('.fluent-read-loading'),
      ), undefined, {
        timeout: args.timeout,
      });
      const beforeLateCss = await readLoadingStyleIsolationState(page);
      const shadowBeforeLateCss = await readLoadingStyleIsolationState(
        page,
        '.fluent-read-loading',
        '#shadow-host',
      );
      assertLoadingStyleIsolation(beforeLateCss, '预先注入 hostile CSS 后');
      assertLoadingStyleIsolation(shadowBeforeLateCss, '开放 ShadowRoot 预先注入 hostile CSS 后');
      await addHostileLoadingIndicatorCss(
        page,
        'hostile-loading-indicator-late',
        LATE_HOSTILE_LOADING_INDICATOR_CSS,
      );
      await page.waitForTimeout(120);
      const afterLateCss = await readLoadingStyleIsolationState(page);
      const shadowAfterLateCss = await readLoadingStyleIsolationState(
        page,
        '.fluent-read-loading',
        '#shadow-host',
      );
      assertLoadingStyleIsolation(afterLateCss, '动态注入 hostile CSS 后');
      assertLoadingStyleIsolation(shadowAfterLateCss, '开放 ShadowRoot 动态注入 hostile CSS 后');
      const screenshot = artifactsDir
        ? path.join(artifactsDir, 'full-page-loading-style-isolation.png')
        : null;
      if (screenshot) await page.screenshot({path: screenshot, fullPage: false});
      loadingStyleIsolationEvidence = {
        expectedStyle: 'sparkle',
        hostileCssBeforeIndicator: true,
        hostileCssAfterIndicator: true,
        beforeLateCss,
        afterLateCss,
        shadowBeforeLateCss,
        shadowAfterLateCss,
        screenshot,
      };
    }
    if (args.verifyFloatingUi) {
      floatingUiEvidence.afterShortcutSamples = await assertNoAutomaticFloatingExpansion(page);
      floatingUiEvidence.progressDuringWork = await waitForFloatingUiState(
        page,
        state => Boolean(state.progressPanel && state.progress &&
          (state.progress.running > 0 || state.progress.queued > 0)),
        args.timeout,
        '等待实际翻译工作展开进度面板超时',
      );
    }
    try {
      await waitFor(page, () => document.querySelector('#paragraph-one .fluent-read-bilingual-content') &&
        document.querySelector('#model-description .fluent-read-bilingual-content') &&
        document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph .fluent-read-bilingual-content') &&
        /[\u3400-\u9fff]/u.test(document.querySelector('#save-button')?.textContent || '') &&
        /[\u3400-\u9fff]/u.test(document.querySelector('#cancel-button')?.textContent || ''), args.timeout);
    } catch (error) {
      const diagnostics = await readShortcutDiagnostics(page);
      throw new Error(`${error.message}\n全文快捷键诊断：${JSON.stringify(diagnostics)}\n翻译请求诊断：${JSON.stringify({ requests: translationFixtureServer.requestCount(), items: translationFixtureServer.translatedItemCount(), payloads: translationFixtureServer.requestPayloads(), events: networkEvents, omitted: omittedNetworkEvents })}`);
    }

    // 在会话已经启动后再插入节点，确认 MutationObserver 能把新内容纳入全文队列。
    await page.evaluate(() => {
      const container = document.querySelector('#dynamic-container');
      const clamp = document.createElement('div');
      clamp.id = 'dynamic-model-description-clamp';
      clamp.className = 'model-description-clamp';
      const paragraph = document.createElement('p');
      paragraph.id = 'dynamic-paragraph';
      paragraph.textContent = 'This virtualized model description is inserted after the full page session starts. Its translated text must expand the newly mounted two-line clamp instead of remaining hidden beneath the source content.';
      clamp.appendChild(paragraph);
      container.appendChild(clamp);
    });
    await waitFor(page, () => document.querySelector('#dynamic-paragraph .fluent-read-bilingual-content'), args.timeout);

    // React/Vue 页面可能在译文已插入后重建原文节点。确认全文观察器不会把
    // 这次宿主 characterData/childList mutation 当成插件自身写入而留下旧译文。
    await page.evaluate(() => {
      const paragraph = document.querySelector('#paragraph-two');
      if (paragraph) paragraph.textContent = 'The second paragraph changed after full-page translation.';
    });
    await waitFor(page, () => {
      const paragraph = document.querySelector('#paragraph-two');
      return paragraph?.textContent?.includes('changed after full-page translation') &&
        Boolean(paragraph.querySelector('.fluent-read-bilingual-content'));
    }, args.timeout);
    const translated = await pageState(page);
    assertTranslated(translated, '第一次全文翻译');
    if (JSON.stringify(translated.iconLigatures) !== JSON.stringify(['account_circle']) ||
        translated.standaloneIcon !== 'keyboard_return' || translated.translationContainsIconLigature) throw new Error(`图标字体结构被翻译：${JSON.stringify(translated)}`);
    const zeroDelayHoverRequestCountBefore = translationFixtureServer.requestCount();
    const zeroDelayHover = await verifyZeroDelayHoverStability(
      page,
      '#paragraph-one',
      activateTestPage,
      artifactsDir ? path.join(artifactsDir, 'full-page-zero-delay-hover-stable.png') : null,
    );
    const zeroDelayHoverRequestCountAfter = translationFixtureServer.requestCount();
    zeroDelayHover.translationRequests = {
      before: zeroDelayHoverRequestCountBefore,
      after: zeroDelayHoverRequestCountAfter,
    };
    if (zeroDelayHoverRequestCountAfter !== zeroDelayHoverRequestCountBefore) {
      throw new Error(`0ms 连续悬浮不应新增翻译请求：${JSON.stringify(zeroDelayHover.translationRequests)}`);
    }
    const passiveHoverRemountRequestCountBefore = translationFixtureServer.requestCount();
    const passiveHoverRemount = await verifyPassiveHoverRemountStability(
      page,
      '#hover-remount-target',
      activateTestPage,
      artifactsDir ? path.join(artifactsDir, 'full-page-passive-hover-remount-stable.png') : null,
    );
    const passiveHoverRemountRequestCountAfter = translationFixtureServer.requestCount();
    passiveHoverRemount.translationRequests = {
      before: passiveHoverRemountRequestCountBefore,
      after: passiveHoverRemountRequestCountAfter,
    };
    if (passiveHoverRemountRequestCountAfter !== passiveHoverRemountRequestCountBefore) {
      throw new Error(`普通 hover DOM 重挂不应新增翻译请求：${JSON.stringify(passiveHoverRemount.translationRequests)}`);
    }
    if (args.verifyFloatingUi) {
      await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
      const offscreenState = await page.evaluate(() => ({
        lastTranslated: Boolean(document.querySelector('#floating-ui-offscreen-59 .fluent-read-bilingual-content')),
        translatedCount: document.querySelectorAll('#floating-ui-offscreen-fixture .fluent-read-bilingual-content').length,
      }));
      if (offscreenState.lastTranslated || offscreenState.translatedCount >= 60) {
        throw new Error(`离屏 fixture 没有保留待滚动候选：${JSON.stringify(offscreenState)}`);
      }
      floatingUiEvidence.translatedCollapsed = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, true) && !state.progressPanel,
        args.timeout,
        '等待全文翻译后的低干扰勾选状态超时',
      );
      assertCollapsedFloatingUi(floatingUiEvidence.translatedCollapsed, true, '全文翻译后');
      await activateTestPage(page);
      await movePointerToFloatingMain(page, floatingUiEvidence.translatedCollapsed);
      floatingUiEvidence.expandedOnHover = await waitForFloatingUiState(
        page,
        isExpandedFloatingUiState,
        Math.min(args.timeout, 15_000),
        '等待主动悬停展开悬浮球超时',
      );
      assertExpandedFloatingUi(floatingUiEvidence.expandedOnHover, '全文翻译后');
      await clickFloatingTranslateTool(page, floatingUiEvidence.expandedOnHover);
      await waitFor(page, () => !document.querySelector('.fluent-read-bilingual-content'), args.timeout);
      floatingUiEvidence.pointerRestored = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, false) && !state.progressPanel,
        args.timeout,
        '等待鼠标点击恢复后收起悬浮球超时',
      );
      assertCollapsedFloatingUi(floatingUiEvidence.pointerRestored, false, '鼠标点击恢复后');
      await toggleFullPage(page, activateTestPage);
      floatingUiEvidence.pointerRetranslateSamples = await assertNoAutomaticFloatingExpansion(page);
      await waitFor(page, () => document.querySelector('#paragraph-one .fluent-read-bilingual-content') &&
        document.querySelector('#model-description .fluent-read-bilingual-content') &&
        document.querySelector('#dynamic-paragraph .fluent-read-bilingual-content') &&
        document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph .fluent-read-bilingual-content') &&
        /[\u3400-\u9fff]/u.test(document.querySelector('#save-button')?.textContent || '') &&
        /[\u3400-\u9fff]/u.test(document.querySelector('#cancel-button')?.textContent || ''), args.timeout);
      await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
      const offscreenStateAfterPointerCycle = await page.evaluate(() => ({
        lastTranslated: Boolean(document.querySelector('#floating-ui-offscreen-59 .fluent-read-bilingual-content')),
        translatedCount: document.querySelectorAll('#floating-ui-offscreen-fixture .fluent-read-bilingual-content').length,
      }));
      if (offscreenStateAfterPointerCycle.lastTranslated || offscreenStateAfterPointerCycle.translatedCount >= 60) {
        throw new Error(`鼠标恢复再翻译后离屏 fixture 状态不正确：${JSON.stringify(offscreenStateAfterPointerCycle)}`);
      }
      await page.evaluate(() => document.querySelector('#floating-ui-offscreen-59')?.scrollIntoView({block: 'center'}));
      floatingUiEvidence.progressAfterScroll = await waitForFloatingUiState(
        page,
        state => Boolean(state.progressPanel && state.progress &&
          (state.progress.running > 0 || state.progress.queued > 0)),
        args.timeout,
        '等待滚动后的离屏任务重新展开进度面板超时',
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector('#floating-ui-offscreen-59 .fluent-read-bilingual-content')),
        undefined,
        {timeout: args.timeout},
      );
      await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
      await page.evaluate(() => window.scrollTo(0, 0));
      floatingUiEvidence.collapsedAfterScroll = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, true) && !state.progressPanel,
        args.timeout,
        '等待滚动批次完成后收起进度面板超时',
      );
      floatingUiEvidence.offscreen = {
        initial: offscreenState,
        afterPointerCycle: offscreenStateAfterPointerCycle,
        translatedAfterScroll: await page.evaluate(() => Boolean(
          document.querySelector('#floating-ui-offscreen-59 .fluent-read-bilingual-content'),
        )),
      };
    }
    const tooltipHover = await verifyTranslatedTooltipHover(page, Math.min(args.timeout, 15000), artifactsDir);
    if (artifactsDir) await page.screenshot({
      path: path.join(artifactsDir, 'full-page-translated.png'),
      fullPage: !args.verifyFloatingUi,
    });

    await toggleFullPage(page, activateTestPage);
    await waitFor(page, () => !document.querySelector('.fluent-read-bilingual-content'), args.timeout);
    const restored = await pageState(page);
    assertRestored(restored);
    if (JSON.stringify(restored.iconLigatures) !== JSON.stringify(['account_circle']) ||
        restored.standaloneIcon !== 'keyboard_return') throw new Error(`图标字体恢复失败：${JSON.stringify(restored)}`);
    if (args.verifyFloatingUi) {
      floatingUiEvidence.restored = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, false) && !state.progressPanel,
        args.timeout,
        '等待恢复原文后的悬浮状态超时',
      );
      assertCollapsedFloatingUi(floatingUiEvidence.restored, false, '恢复原文后');
    }
    if (artifactsDir) await page.screenshot({
      path: path.join(artifactsDir, 'full-page-restored.png'),
      fullPage: !args.verifyFloatingUi,
    });

    const unchangedAttributeStability = await verifyUnchangedAttributeStability({
      page, context, args, createIsolatedPage, activateTestPage, translationFixtureServer, artifactsDir,
    });

    // 在全文会话已恢复的干净状态下验证失败操作。专用临时配置只在这一小段切到
    // Microsoft loopback，避免 freeTranslation 的 DeepLX/Google 回退吞掉预期失败。
    const failureActions = await runFailureActionScenario({
      page,
      context,
      args,
      createIsolatedPage,
      activateTestPage,
      translationFixtureServer,
      artifactsDir,
    });

    if (args.verifyFloatingUi) {
      await page.evaluate(() => {
        const paragraph = document.createElement('p');
        paragraph.id = 'floating-ui-progress-only-fixture';
        paragraph.textContent = `A newly visible uncached paragraph keeps the progress-only assertion observable ${crypto.randomUUID()}.`;
        document.body.prepend(paragraph);
      });
      await readConfig(context, args.timeout, {disableFloatingBall: true}, createIsolatedPage);
      floatingUiEvidence.progressOnlyInitial = await waitForFloatingUiState(
        page,
        state => !state.host && state.progressHost && !state.progressPanel,
        args.timeout,
        '等待仅进度面板配置生效超时',
      );
      await toggleFullPage(page, activateTestPage);
      floatingUiEvidence.progressOnlyDuringWork = await waitForFloatingUiState(
        page,
        state => Boolean(state.progressPanel && !state.progressCompact && state.progress &&
          (state.progress.running > 0 || state.progress.queued > 0)),
        args.timeout,
        '等待无悬浮球时展开实际进度面板超时',
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector('#paragraph-one .fluent-read-bilingual-content') &&
          document.querySelector('#floating-ui-progress-only-fixture .fluent-read-bilingual-content')),
        undefined,
        {timeout: args.timeout},
      );
      await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
      floatingUiEvidence.progressOnlyCompact = await waitForFloatingUiState(
        page,
        state => Boolean(!state.host && state.progressCompact && state.progressCompactCheck &&
          state.progress && state.progress.running === 0 && state.progress.queued === 0 && state.progress.offscreen > 0),
        args.timeout,
        '等待离屏任务退化为淡勾选超时',
      );
      await toggleFullPage(page, activateTestPage);
      await waitFor(page, () => !document.querySelector('.fluent-read-bilingual-content'), args.timeout);
      floatingUiEvidence.progressOnlyRestored = await waitForFloatingUiState(
        page,
        state => !state.host && !state.progressPanel,
        args.timeout,
        '等待仅进度面板模式恢复原文超时',
      );
      await movePointerAwayFromFloatingUi(page);
      await readConfig(context, args.timeout, {disableFloatingBall: false}, createIsolatedPage);
      floatingUiEvidence.remountedBeforeRetranslate = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, false),
        args.timeout,
        '等待重新启用悬浮球超时',
      );
    }

    if (args.verifyLoadingStyleIsolation) {
      await page.emulateMedia({reducedMotion: 'reduce'});
      await page.evaluate(() => {
        const paragraph = document.createElement('p');
        paragraph.id = 'loading-reduced-motion-fixture';
        paragraph.textContent = `A unique paragraph verifies reduced motion for the isolated loading style ${crypto.randomUUID()}.`;
        document.querySelector('main')?.appendChild(paragraph);
      });
    }
    await toggleFullPage(page, activateTestPage);
    if (args.verifyLoadingStyleIsolation) {
      const reducedMotionSelector = '#loading-reduced-motion-fixture .fluent-read-loading';
      await page.waitForFunction((selector) => Boolean(document.querySelector(selector)), reducedMotionSelector, {
        timeout: args.timeout,
      });
      const reducedMotion = await readLoadingStyleIsolationState(page, reducedMotionSelector);
      assertLoadingStyleIsolation(reducedMotion, '系统减少动态效果下', 'static');
      loadingStyleIsolationEvidence.reducedMotion = reducedMotion;
    }
    await waitFor(page, () => document.querySelector('#paragraph-one .fluent-read-bilingual-content') &&
      document.querySelector('#model-description .fluent-read-bilingual-content') &&
      document.querySelector('#dynamic-paragraph .fluent-read-bilingual-content') &&
      document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph .fluent-read-bilingual-content') &&
      /[\u3400-\u9fff]/u.test(document.querySelector('#save-button')?.textContent || '') &&
      /[\u3400-\u9fff]/u.test(document.querySelector('#cancel-button')?.textContent || ''), args.timeout);
    const retranslated = await pageState(page);
    assertTranslated(retranslated, '再次全文翻译');
    if (JSON.stringify(retranslated.iconLigatures) !== JSON.stringify(['account_circle']) ||
        retranslated.standaloneIcon !== 'keyboard_return' || retranslated.translationContainsIconLigature) throw new Error(`再次翻译破坏图标：${JSON.stringify(retranslated)}`);
    if (args.verifyFloatingUi) {
      await page.waitForFunction(() => !document.querySelector('.fluent-read-loading'), undefined, {timeout: args.timeout});
      floatingUiEvidence.retranslated = await waitForFloatingUiState(
        page,
        state => isCollapsedFloatingUiState(state, true) && !state.progressPanel,
        args.timeout,
        '等待再次全文翻译后的悬浮状态超时',
      );
      assertCollapsedFloatingUi(floatingUiEvidence.retranslated, true, '再次全文翻译后');
    }
    if (artifactsDir) await page.screenshot({
      path: path.join(artifactsDir, 'full-page-retranslated.png'),
      fullPage: !args.verifyFloatingUi,
    });
    await Promise.allSettled([...pendingWorkerFixtureInstalls]);
    if (workerFixtureInstallErrors.length > 0) {
      throw new Error(`替换 service worker 安装全文翻译 fixture 失败：${JSON.stringify(workerFixtureInstallErrors)}`);
    }
    assertNoRuntimeErrors(runtimeErrors);
    const fixtureTranslationRequestCount = translationFixtureServer.requestCount();
    const fixtureTranslationItemCount = translationFixtureServer.translatedItemCount();
    assertDeterministicFixtureTraffic(fixtureTranslationRequestCount, unexpectedNetworkRequests);
    if (translationFixtureServer.requestPayloads().flat().some((text) => /account_circle|keyboard_return/.test(text))) {
      throw new Error('图标字体连字进入了翻译服务请求');
    }

    const evidence = {
      ok: true,
      windowMode: args.background ? windowPlacement?.mode : 'headed-isolated',
      launchMode,
      focusPolicy,
      windowPlacement,
      profileDir,
      url: args.url,
      extensionId: configResult.extensionId,
      config: {
        floatingBallHotkey: configResult.config.floatingBallHotkey,
        service: configResult.config.service,
        display: configResult.config.display,
        mouseHoverTranslationDelay: configResult.config.mouseHoverTranslationDelay,
        bilingualSentenceHighlightEnabled: configResult.config.bilingualSentenceHighlightEnabled,
        disableFloatingBall: configResult.config.disableFloatingBall,
        translationProgressPanelEnabled: configResult.config.translationProgressPanelEnabled,
        fullPageTranslationMode: configResult.config.fullPageTranslationMode,
        animations: configResult.config.animations,
        translationLoadingStyle: configResult.config.translationLoadingStyle,
      },
      fixtureTranslationRequestCount,
      fixtureTranslationItemCount,
      unexpectedNetworkRequests,
      translated,
      restored,
      retranslated,
      zeroDelayHover,
      passiveHoverRemount,
      cancelledHoverGesture,
      unchangedAttributeStability,
      tooltipHover,
      failureActions,
      floatingUi: floatingUiEvidence,
      loadingStyleIsolation: loadingStyleIsolationEvidence,
      consoleErrors: runtimeErrors,
      screenshots: artifactsDir ? [
        path.join(artifactsDir, 'full-page-translated.png'),
        path.join(artifactsDir, 'full-page-restored.png'),
        path.join(artifactsDir, 'full-page-retranslated.png'),
        ...(zeroDelayHover.screenshot ? [zeroDelayHover.screenshot] : []),
        ...(passiveHoverRemount.screenshot ? [passiveHoverRemount.screenshot] : []),
        ...(unchangedAttributeStability.screenshot ? [unchangedAttributeStability.screenshot] : []),
        ...(loadingStyleIsolationEvidence?.screenshot ? [loadingStyleIsolationEvidence.screenshot] : []),
        ...failureActions.screenshots,
      ] : [],
    };
    if (artifactsDir) {
      fs.writeFileSync(path.join(artifactsDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await closeBrowser();
    await translationFixtureServer?.close().catch(() => {});
    await fixtureServer?.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertCancelledHoverGesture,
  assertDeterministicFixtureTraffic,
  assertNoRuntimeErrors,
  assertSingleSourceProtection,
  assertSingleCloneRestoration,
  assertUnchangedAttributeStability,
  buildFixtureMicrosoftResponseBody,
  createFixtureRequestHandler,
  getConfigurationPage,
  parseArgs,
  startFixtureServer,
  startTranslationFixtureServer,
};
