#!/usr/bin/env node

const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');

function parseArgs(argv, env = process.env) {
  const args = {
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    background: true,
    focusSafeHelper: env.FLUENTREAD_FOCUS_SAFE_HELPER || path.join(__dirname, 'testing/focus-safe-browser.cjs'),
    timeout: 60000,
    suite: 'full',
    gmMode: 'legacy',
    engine: 'chromium',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--background') continue;
    if (token === '--headed') {
      args.background = false;
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
  if (!['full', 'selects', 'compact-save', 'options', 'options-route'].includes(args.suite)) throw new Error(`无法识别测试套件：${args.suite}`);
  if (!['legacy', 'modern'].includes(args.gmMode)) throw new Error(`无法识别 GM 模式：${args.gmMode}`);
  if (!['chromium', 'webkit'].includes(args.engine)) throw new Error(`无法识别浏览器引擎：${args.engine}`);
  if (args.engine === 'webkit' && !args.background) throw new Error('WebKit 回归只允许无窗口的后台模式');
  if (!args.artifact) throw new Error('必须传入 --artifact');
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root');
  if (!args.artifactsDir) throw new Error('必须传入 --artifacts-dir');
  if (args.background && args.engine === 'chromium' && !args.focusSafeHelper) {
    throw new Error('后台模式必须传入 --focus-safe-helper 或设置 FLUENTREAD_FOCUS_SAFE_HELPER');
  }
  if (args.focusSafeHelper) args.focusSafeHelper = path.resolve(args.focusSafeHelper);
  return args;
}

function loadPlaywright(root) {
  try {
    return require('playwright');
  } catch {
    return createRequire(path.join(path.resolve(root), '__fluentread_userscript_loader__.cjs'))('playwright');
  }
}

function loadFocusSafeBrowser(helperPath) {
  if (!fs.existsSync(helperPath)) throw new Error(`找不到后台浏览器辅助脚本：${helperPath}`);
  const helper = require(helperPath);
  for (const name of [
    'launchFocusSafePersistentContext',
    'newPageWithoutForeground',
    'activateExtensionTabWithoutForeground',
  ]) {
    if (typeof helper[name] !== 'function') throw new Error(`后台浏览器辅助脚本缺少接口：${name}`);
  }
  return helper;
}

async function preloadUserscriptRequires(page, artifact) {
  const root = path.resolve(path.dirname(artifact), '../..');
  const source = fs.readFileSync(artifact, 'utf8');
  const vendorRequire = /^\/\/ @require\s+https?:\/\/[^\s]+\/fluentread-vendor\.v1\.js$/m.test(source);
  const dataRequire = /^\/\/ @require\s+https?:\/\/[^\s]+\/fluentread-data\.v1\.js$/m.test(source);
  const requires = [...source.matchAll(/^\/\/ @require\s+https:\/\/cdn\.jsdelivr\.net\/(?:npm\/([^\s]+)|gh\/FluentRead\/FluentRead@[a-f0-9]{40}\/userscript\/(vueElementPlusBridge\.v1\.js))$/gm)]
    .map((match) => match[1] || match[2]);
  const vendors = [
    ['vue@', 'vue/dist/vue.global.prod.js'],
    ['element-plus@', 'element-plus/dist/index.full.min.js'],
    ['@element-plus/icons-vue@', '@element-plus/icons-vue/dist/index.iife.min.js'],
    ['tldts@', 'tldts/dist/index.umd.min.js'],
    ['pako@', 'pako/dist/pako_inflate.min.js'],
  ];
  for (const required of requires) {
    if (required === 'vueElementPlusBridge.v1.js') {
      await page.addScriptTag({path: path.join(root, 'userscript', required)});
      continue;
    }
    const entry = vendors.find(([prefix]) => required.startsWith(prefix));
    if (!entry) throw new Error(`未知的 userscript @require：${required}`);
    const localPath = path.join(root, 'node_modules', entry[1]);
    if (!fs.existsSync(localPath)) throw new Error(`找不到 userscript @require 测试依赖：${localPath}`);
    await page.addScriptTag({path: localPath});
  }
  if (vendorRequire) {
    await page.addScriptTag({path: path.join(root, '.output/userscript-vendor/fluentread-vendor.v1.js')});
    requires.push('fluentread-vendor.v1.js');
    if (!await page.evaluate(() => {
      const vendor = globalThis.FluentReadUserscriptVendor;
      return typeof vendor?.ai?.generateText === 'function'
        && typeof vendor?.ai?.APICallError?.isInstance === 'function'
        && typeof vendor?.openAICompatible?.createOpenAICompatible === 'function'
        && typeof vendor?.sha256 === 'function'
        && typeof vendor?.md5 === 'function'
        && typeof vendor?.hmacSha256 === 'function'
        && typeof vendor?.aes?.encrypt === 'function'
        && typeof vendor?.Dexie === 'function'
        && typeof vendor?.francMin?.francAll === 'function';
    })) {
      throw new Error('userscript vendor @require did not expose its pinned library exports');
    }
  }
  if (dataRequire) {
    await page.addScriptTag({path: path.join(root, '.output/userscript-greasyfork/fluentread-data.v1.js')});
    requires.push('fluentread-data.v1.js');
    if (!await page.evaluate(() => Boolean(globalThis.__FLUENTREAD_USERSCRIPT_DATA__?.english?.messages
      && globalThis.__FLUENTREAD_USERSCRIPT_DATA__?.zhCNMessages
      && globalThis.__FLUENTREAD_USERSCRIPT_DATA__?.siteCatalogs
      && globalThis.__FLUENTREAD_USERSCRIPT_DATA__?.css))) {
      throw new Error('userscript data @require did not expose UI, site and CSS data');
    }
  }
  if (requires.length && await page.evaluate(() =>
    typeof Vue === 'undefined' || typeof ElementPlus === 'undefined'
    || typeof ElementPlusIconsVue === 'undefined' || typeof tldts === 'undefined'
    || typeof pako === 'undefined')) {
    throw new Error('userscript @require 依赖未在浏览器中建立全局入口');
  }
  return requires;
}

function assertDedicatedProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
  ];
  if (forbidden.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
}

async function startFixtureServer() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FluentRead userscript fixture</title></head>
<body>
  <nav id="forbidden-nav">Navigation should remain original</nav>
  <main>
    <h1 id="heading">Userscript translation fixture</h1>
    <p id="target">FluentRead keeps the original paragraph and adds a safe bilingual translation.</p>
    <p id="adjacent">This adjacent paragraph must stay untouched during hover translation.</p>
    <img id="unsupported-image" width="24" height="24" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <div id="dynamic-root"></div>
    <div id="shadow-host"></div>
  </main>
  <script>
    const root = document.querySelector('#shadow-host').attachShadow({mode: 'open'});
    root.innerHTML = '<p id="shadow-paragraph">Open shadow root content should be translated.</p>';
  <\/script>
</body></html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () => new Promise((resolve) => {server.close(resolve); server.closeAllConnections();}),
  };
}

async function waitForCount(page, selector, expected, timeout) {
  await page.waitForFunction(
    ({selector: targetSelector, expected: count}) =>
      document.querySelector(targetSelector)?.querySelectorAll('.fluent-read-bilingual-content').length === count,
    {selector, expected},
    {timeout},
  );
}

async function waitForShadowCount(page, hostSelector, targetSelector, expected, timeout) {
  await page.waitForFunction(
    ({hostSelector: host, targetSelector: target, expected: count}) =>
      document.querySelector(host)?.shadowRoot?.querySelector(target)
        ?.querySelectorAll('.fluent-read-bilingual-content').length === count,
    {hostSelector, targetSelector, expected},
    {timeout},
  );
}

async function hoverToggle(page, expected, timeout) {
  const target = page.locator('#target');
  const box = await target.boundingBox();
  if (!box) throw new Error('hover 目标不可见');
  const x = box.x + Math.min(Math.max(box.width * .35, 10), box.width - 10);
  const y = box.y + box.height * .5;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await waitForCount(page, '#target', expected, timeout);
}

async function fullPageToggle(page, targetCount, adjacentCount, timeout) {
  await page.keyboard.down('Alt');
  await page.keyboard.press('t');
  await page.keyboard.up('Alt');
  await Promise.all([
    waitForCount(page, '#target', targetCount, timeout),
    waitForCount(page, '#adjacent', adjacentCount, timeout),
    waitForCount(page, '#heading', targetCount, timeout),
    waitForShadowCount(page, '#shadow-host', '#shadow-paragraph', targetCount, timeout),
    waitForCount(page, '#dynamic-paragraph', targetCount, timeout),
    waitForShadowCount(page, '#dynamic-shadow-host', '#dynamic-shadow-paragraph', targetCount, timeout),
  ]);
}

async function readState(page) {
  return page.evaluate(() => ({
    url: location.href,
    injected: Boolean(document.querySelector('#fluent-read-page-styles')),
    floatingBall: Boolean(document.querySelector('#fluent-read-floating-ball-container')),
    settings: Boolean(document.querySelector('#fluent-read-userscript-settings-container')),
    target: document.querySelector('#target')?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    adjacent: document.querySelector('#adjacent')?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    heading: document.querySelector('#heading')?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    nav: document.querySelector('#forbidden-nav')?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    dynamic: document.querySelector('#dynamic-paragraph')?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    shadow: document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-paragraph')
      ?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    dynamicShadow: document.querySelector('#dynamic-shadow-host')?.shadowRoot?.querySelector('#dynamic-shadow-paragraph')
      ?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    targetTranslation: document.querySelector('#target .fluent-read-bilingual-content')?.textContent?.trim() || '',
  }));
}

async function selectUserscriptTestPage(background, context, createIsolatedPage) {
  // focus-safe helper 可能持有并异步关闭自己的启动页；后台回归必须创建独立页面，
  // 不能复用 context.pages()[0] 后再等待长 userscript 注入。
  if (background) return createIsolatedPage();
  return context.pages()[0] || createIsolatedPage();
}

function decodeStoredValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function readSharedUserscriptCount(store) {
  let base = 0;
  let replicas = 0;
  for (const [key, rawValue] of store) {
    const value = decodeStoredValue(rawValue);
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.value) || value.value < 0) continue;
    if (key.startsWith('fluentread:count:v1:base:')) base = Math.max(base, value.value);
    if (key.startsWith('fluentread:count:v1:replica:')) replicas += value.value;
  }
  const total = base + replicas;
  if (!Number.isSafeInteger(total)) throw new Error('userscript smoke 计数超过安全整数范围');
  return total;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifact = path.resolve(args.artifact);
  const artifactsDir = path.resolve(args.artifactsDir);
  if (!fs.existsSync(artifact)) throw new Error(`userscript 产物不存在：${artifact}`);
  if (args.engine === 'chromium' && !fs.existsSync(args.browserPath)) throw new Error(`Chromium 浏览器不存在：${args.browserPath}`);
  const focusSafe = args.background && args.engine === 'chromium'
    ? loadFocusSafeBrowser(args.focusSafeHelper)
    : null;
  fs.mkdirSync(artifactsDir, {recursive: true});

  const {chromium, webkit} = loadPlaywright(args.playwrightRoot);
  const fixture = await startFixtureServer();
  let profileDir;
  let context;
  let closeBrowser;
  let primaryError;
  let launchAttempted = false;
  let createIsolatedPage = () => context.newPage();
  let launchMode = args.background ? null : 'playwright-headed';
  let focusPolicy = args.background ? null : 'foreground-authorized';
  let windowPlacement = args.background
    ? null
    : {mode: 'headed-explicit-foreground', windowState: 'normal', viewport: {width: 1280, height: 900}};
  const sharedGmStore = new Map();
  sharedGmStore.set('local:config', JSON.stringify({
    on: true,
    autoTranslate: false,
    from: 'auto',
    to: 'zh-Hans',
    service: 'freeTranslation',
    useCache: false,
    animations: true,
    translationLoadingStyle: 'orbit',
    disableFloatingBall: false,
    selectionAreaEnabled: true,
    disableImageTranslator: false,
    videoTranslationEnabled: true,
  }));
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-userscript-edge-'));
    assertDedicatedProfile(profileDir);
    const browserArgs = [
        '--no-first-run',
        '--no-default-browser-check',
    ];
    if (args.engine === 'webkit') {
      launchAttempted = true;
      const browser = await webkit.launch({headless: true, timeout: args.timeout});
      closeBrowser = () => browser.close();
      context = await browser.newContext({viewport: {width: 1280, height: 900}});
      launchMode = 'playwright-webkit-headless';
      focusPolicy = 'headless-no-window';
      windowPlacement = {mode: 'headless', visible: false, hidden: true, browserFrontmost: false};
    } else if (args.background) {
      launchAttempted = true;
      const browserSession = await focusSafe.launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath: args.browserPath,
        headless: false,
        background: true,
        browserArgs,
        viewport: {width: 1280, height: 900},
        timeout: args.timeout,
      });
      guardBrowserClose(browserSession, profileDir);
      closeBrowser = browserSession.close;
      context = browserSession.context;
      createIsolatedPage = () => focusSafe.newPageWithoutForeground(context, args.timeout);
      launchMode = browserSession.launchMode;
      focusPolicy = browserSession.focusPolicy;
      windowPlacement = browserSession.windowPlacement;
    } else {
      launchAttempted = true;
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: args.browserPath,
        headless: false,
        viewport: {width: 1280, height: 900},
        args: browserArgs,
      });
      closeBrowser = () => context.close();
    }
    await context.exposeFunction('__fluentReadGmGet', (key, fallback) => (
      sharedGmStore.has(key) ? sharedGmStore.get(key) : fallback
    ));
    await context.exposeFunction('__fluentReadGmSet', (key, value) => {
      sharedGmStore.set(key, value);
    });
    await context.exposeFunction('__fluentReadGmDelete', (key) => {
      sharedGmStore.delete(key);
    });
    await context.exposeFunction('__fluentReadGmList', () => [...sharedGmStore.keys()]);
    await context.addInitScript(({modern}) => {
      // Reproduce issue #524's Dexie collision by making a different version
      // visible in the same execution realm before FluentRead's bundle runs.
      const hostDexie = Object.freeze({semVer: '4.4.4', owner: 'host-page-fixture'});
      Object.defineProperty(window, '__fluentReadHostDexieBeforeInjection', {value: hostDexie});
      window[Symbol.for('Dexie')] = hostDexie;
      Object.defineProperty(window, '__fluentReadOriginalAttachShadow', {value: Element.prototype.attachShadow});
      Object.defineProperty(window, '__fluentReadUserscriptSettingsShadow', {value: null, writable: true});
      Object.defineProperty(window, '__fluentReadSmokeBridgeEvents', {value: {shadow: 0, route: 0}});
      document.addEventListener('fluentread-open-shadow-root', () => { window.__fluentReadSmokeBridgeEvents.shadow += 1; });
      document.addEventListener('fluentread-route-change', () => { window.__fluentReadSmokeBridgeEvents.route += 1; });
      if (modern) {
        window.GM = {
          getValue: (key, fallback) => window.__fluentReadGmGet(key, fallback),
          setValue: (key, value) => window.__fluentReadGmSet(key, value),
          deleteValue: (key) => window.__fluentReadGmDelete(key),
          listValues: () => window.__fluentReadGmList(),
        };
      } else {
        window.GM_getValue = (key, fallback) => window.__fluentReadGmGet(key, fallback);
        window.GM_setValue = (key, value) => window.__fluentReadGmSet(key, value);
        window.GM_deleteValue = (key) => window.__fluentReadGmDelete(key);
        window.GM_listValues = () => window.__fluentReadGmList();
        window.GM_registerMenuCommand = () => 1;
      }
      window.GM_addStyle = (css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.documentElement.appendChild(style);
        return style;
      };
      const request = (details) => {
        let aborted = false;
        let complete;
        let fail;
        const pending = modern ? new Promise((resolve, reject) => { complete = resolve; fail = reject; }) : null;
        const timer = setTimeout(() => {
          if (aborted) return;
          try {
            const body = JSON.parse(String(details.data || '[]'));
            const responseText = JSON.stringify(body.map((text) => ({
              translations: [{text: `译文：${String(text).replace(/<[^>]+>/g, '')}`}],
            })));
            const response = {
              status: 200,
              statusText: 'OK',
              responseText,
              responseHeaders: 'content-type: application/json; charset=utf-8',
              finalUrl: details.url,
            };
            if (modern) complete(response);
            else details.onload?.(response);
          } catch (error) {
            if (modern) fail(error);
            else details.onerror?.({status: 500, statusText: String(error), responseText: ''});
          }
        }, 1000);
        const abort = () => {
          aborted = true;
          clearTimeout(timer);
          if (modern) fail(new DOMException('Aborted', 'AbortError'));
          else details.onabort?.({status: 0, statusText: 'aborted'});
        };
        if (modern) { pending.abort = abort; return pending; }
        return {abort};
      };
      if (modern) window.GM.xmlHttpRequest = request;
      else window.GM_xmlhttpRequest = request;
    }, {modern: args.gmMode === 'modern'});

    const page = await selectUserscriptTestPage(args.background, context, createIsolatedPage);
    await page.emulateMedia({reducedMotion: 'no-preference'});
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });
    await page.goto(fixture.url, {waitUntil: 'domcontentloaded', timeout: args.timeout});
    await page.evaluate(() => {
      localStorage.setItem('__fluentReadHostLocalSentinel', 'host-local-sentinel');
      sessionStorage.setItem('__fluentReadHostSessionSentinel', 'host-session-sentinel');
      Object.defineProperty(window, '__fluentReadBrowserBeforeInjection', {value: window.browser});
      Object.defineProperty(window, '__fluentReadChromeBeforeInjection', {value: window.chrome});
    });
    let preloadedRequires;
    try {
      preloadedRequires = await preloadUserscriptRequires(page, artifact);
      await page.addScriptTag({path: artifact});
      await page.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: args.timeout});
      await page.addStyleTag({content: `
        span.fluent-read-loading {
          all: revert !important;
          display: block !important;
          width: 180px !important;
          height: 120px !important;
          padding: 30px !important;
          border: 20px solid red !important;
          opacity: 0 !important;
          visibility: hidden !important;
          transform: scale(7) !important;
          animation: spin 30s infinite !important;
        }
        span.fluent-read-loading::before,
        span.fluent-read-loading::after {
          content: "HOST PAGE" !important;
          display: block !important;
        }
        @keyframes spin { to { transform: rotate(10deg) scale(9); } }
      `});
    } catch (error) {
      const bootstrapState = page.isClosed()
        ? {pageClosed: true}
        : await page.evaluate(() => ({
          pageClosed: false,
          bootstrapped: window.__fluentReadUserscriptBootstrapped,
          readyState: document.readyState,
          stylePresent: Boolean(document.querySelector('#fluent-read-page-styles')),
          bodyText: document.body?.innerText?.slice(0, 200) || '',
        })).catch((cause) => ({diagnosticError: String(cause)}));
      throw new Error(`${error.message}\nuserscript 启动诊断：${JSON.stringify({bootstrapState, consoleErrors})}`);
    }
    await page.waitForSelector('#fluent-read-floating-ball-container', {state: 'attached', timeout: args.timeout});
    const pageGlobalsPreserved = await page.evaluate(() => ({
      browser: window.browser === window.__fluentReadBrowserBeforeInjection,
      chrome: window.chrome === window.__fluentReadChromeBeforeInjection,
    }));
    if (!pageGlobalsPreserved.browser || !pageGlobalsPreserved.chrome) {
      throw new Error(`页面 browser/chrome 全局被 userscript 覆盖：${JSON.stringify(pageGlobalsPreserved)}`);
    }
    const hostDexie = await page.evaluate(() => {
      const value = window[Symbol.for('Dexie')];
      return {
        semVer: value?.semVer,
        owner: value?.owner,
        sameInstance: value === window.__fluentReadHostDexieBeforeInjection,
      };
    });
    if (hostDexie.semVer !== '4.4.4' || hostDexie.owner !== 'host-page-fixture'
      || !hostDexie.sameInstance) {
      throw new Error(`userscript 覆盖了宿主页面的 Dexie 注册：${JSON.stringify(hostDexie)}`);
    }

    const gmStoreBeforeReinjection = new Map(sharedGmStore);
    await page.addScriptTag({path: artifact});
    await page.waitForTimeout(100);
    const reinjectionState = await page.evaluate(() => ({
      styleHosts: document.querySelectorAll('#fluent-read-page-styles').length,
      floatingBallHosts: document.querySelectorAll('#fluent-read-floating-ball-container').length,
      settingsHosts: document.querySelectorAll('#fluent-read-userscript-settings-container').length,
    }));
    const changedGmKeys = [...new Set([
      ...gmStoreBeforeReinjection.keys(),
      ...sharedGmStore.keys(),
    ])].filter((key) => gmStoreBeforeReinjection.get(key) !== sharedGmStore.get(key));
    if (reinjectionState.styleHosts !== 1
      || reinjectionState.floatingBallHosts !== 1
      || reinjectionState.settingsHosts !== 0
      || changedGmKeys.length > 0) {
      throw new Error(`userscript 重复注入不是幂等操作：${JSON.stringify({reinjectionState, changedGmKeys})}`);
    }

    if (args.suite === 'options-route') {
      const settingsPage = await createIsolatedPage();
      settingsPage.on('pageerror', (error) => consoleErrors.push(`settings pageerror: ${error.message}`));
      settingsPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`settings console: ${message.text()}`);
      });
      await settingsPage.goto(`${fixture.url}#fluentread-userscript-settings/settings-general`, {waitUntil: 'domcontentloaded', timeout: args.timeout});
      await settingsPage.evaluate(() => {
        const original = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function captureSettingsRoot(init) {
          const root = original.call(this, init);
          if (this.getAttribute('data-fluent-read-userscript-host') === 'fluent-read-userscript-settings-ui') {
            window.__fluentReadUserscriptSettingsShadow = root;
          }
          return root;
        };
      });
      await preloadUserscriptRequires(settingsPage, artifact);
      await settingsPage.addScriptTag({path: artifact});
      await settingsPage.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow?.querySelector('.settings-app'), undefined, {timeout: args.timeout});
      const result = await settingsPage.evaluate(() => {
        const host = document.querySelector('#fluent-read-userscript-settings-container');
        const root = window.__fluentReadUserscriptSettingsShadow;
        return {
          hash: location.hash,
          closedShadow: host?.shadowRoot === null,
          fullOptions: Boolean(root.querySelector('.settings-app [data-section="settings-services"]')),
          overlayClose: Boolean(root.querySelector('button.userscript-settings-close')),
          contentStyles: document.querySelectorAll('#fluent-read-page-styles').length,
          floatingBalls: document.querySelectorAll('#fluent-read-floating-ball-container').length,
          hostRootClass: document.documentElement.className,
          hostRootStyle: document.documentElement.getAttribute('style'),
        };
      });
      if (!result.closedShadow || !result.fullOptions || result.overlayClose || result.contentStyles || result.floatingBalls
        || result.hostRootClass || result.hostRootStyle) {
        throw new Error(`独立设置标签页启动了网页功能或污染了宿主：${JSON.stringify(result)}`);
      }
      await settingsPage.screenshot({path: path.join(artifactsDir, 'userscript-options-route.png'), fullPage: false});
      const evidence = {result, sourceFloatingBall: await page.locator('#fluent-read-floating-ball-container').count(),
        launchMode, focusPolicy, windowPlacement,
        transport: 'local fixture with deterministic GM shim; no live provider or userscript manager certification'};
      fs.writeFileSync(path.join(artifactsDir, 'options-route-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      if (consoleErrors.length) throw new Error(`浏览器控制台出现错误：${JSON.stringify(consoleErrors)}`);
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }

    if (args.suite === 'options') {
      await page.evaluate(() => history.replaceState(null, '', '#host-route'));
      const hostBefore = await page.evaluate(() => ({
        hash: location.hash,
        title: document.title,
        rootClass: document.documentElement.className,
        rootStyle: document.documentElement.getAttribute('style'),
        rootSkin: document.documentElement.dataset.interfaceSkin,
      }));
      await page.evaluate(() => {
        const originalAttachShadow = Element.prototype.attachShadow;
        const originalOpen = window.open;
        window.open = () => null; // Force the documented same-page fallback when tabs are blocked.
        Element.prototype.attachShadow = function captureSettingsRoot(init) {
          const root = originalAttachShadow.call(this, init);
          if (this.getAttribute('data-fluent-read-userscript-host') === 'fluent-read-userscript-settings-ui') {
            window.__fluentReadUserscriptSettingsShadow = root;
          }
          return root;
        };
        window.__fluentReadRestoreSettingsObserver = () => {
          Element.prototype.attachShadow = originalAttachShadow;
          window.open = originalOpen;
        };
        window.dispatchEvent(new CustomEvent('fluentread-userscript-open-settings'));
      });
      try {
        await page.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow?.querySelector('.settings-app'), undefined, {timeout: args.timeout});
      } finally {
        await page.evaluate(() => window.__fluentReadRestoreSettingsObserver());
      }
      const settingsHost = page.locator('#fluent-read-userscript-settings-container');
      const initial = await settingsHost.evaluate((host) => ({
        closedShadow: host.shadowRoot === null,
        lightDomText: host.textContent?.trim() || '',
        viewportWidth: host.getBoundingClientRect().width,
      }));
      if (!initial.closedShadow || initial.lightDomText || initial.viewportWidth < 300) {
        throw new Error(`完整 Options 未隔离在全视口 closed Shadow DOM：${JSON.stringify(initial)}`);
      }
      const ballDuringSettings = await page.evaluate(() => {
        const ball = document.querySelector('#fluent-read-floating-ball-container');
        return ball ? {
          hostName: ball.getAttribute('data-fluent-read-userscript-host'),
          suspended: ball.getAttribute('data-fluent-read-ui-suspended'),
          computedVisibility: getComputedStyle(ball).visibility,
        } : null;
      });
      if (ballDuringSettings?.suspended !== 'true' || ballDuringSettings.computedVisibility !== 'hidden') {
        throw new Error(`页内完整设置没有遮蔽悬浮球：${JSON.stringify(ballDuringSettings)}`);
      }
      await page.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow?.querySelector('[role="radiogroup"][aria-label="界面主题"] button'), undefined, {timeout: args.timeout});
      await page.evaluate(() => {
        const input = window.__fluentReadUserscriptSettingsShadow.querySelector('input[aria-label="默认网页翻译服务"]');
        if (!input) throw new Error('完整 Options 缺少默认翻译服务选择器');
        input.closest('.el-select__wrapper')?.click();
      });
      await page.waitForFunction(() => [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-select-dropdown')]
        .some((menu) => menu.getBoundingClientRect().height > 0), undefined, {timeout: args.timeout});
      const dropdownInsideShadow = await page.evaluate(() => [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-select-dropdown')]
        .some((menu) => menu.getBoundingClientRect().height > 0 && menu.getRootNode() === window.__fluentReadUserscriptSettingsShadow));
      if (!dropdownInsideShadow) throw new Error('翻译服务下拉菜单离开了 closed ShadowRoot');
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const root = window.__fluentReadUserscriptSettingsShadow;
        const dark = [...root.querySelectorAll('[role="radiogroup"][aria-label="界面主题"] button')]
          .find((button) => button.textContent.trim() === '暗色主题');
        if (!dark) throw new Error('找不到完整 Options 的暗色主题设置');
        dark.click();
      });
      await page.waitForFunction(() => {
        const root = window.__fluentReadUserscriptSettingsShadow;
        return root?.host.classList.contains('dark');
      }, undefined, {timeout: args.timeout});
      await page.waitForFunction(() => window.__fluentReadGmGet('local:config', null)
        .then((raw) => JSON.parse(raw || '{}').theme === 'dark'), undefined, {timeout: args.timeout});
      const unavailableSections = [
        // 圈选与模型用量已合并进对应父页面，不再是独立导航按钮。
        'settings-image-translation', 'settings-video', 'settings-writing', 'settings-translation-stats',
      ];
      const visitedSections = [];
      for (const id of [...unavailableSections, 'settings-vocabulary', 'settings-data', 'settings-about']) {
        await page.evaluate((section) => {
          window.__fluentReadUserscriptSettingsShadow.querySelector(`button[data-section="${section}"]`).click();
        }, id);
        await page.waitForFunction((section) => {
          const root = window.__fluentReadUserscriptSettingsShadow;
          return root?.querySelector(`button[data-section="${section}"]`)?.getAttribute('aria-current') === 'page'
            && Boolean(root.querySelector(`#${section}`));
        }, id, {timeout: args.timeout});
        if (await page.evaluate(() => location.hash) !== '#host-route') {
          throw new Error(`页内 ${id} 导航改写了宿主网页路由`);
        }
        if (unavailableSections.includes(id)) {
          const unavailable = await page.evaluate((section) => {
            const root = window.__fluentReadUserscriptSettingsShadow;
            const notice = root.querySelector(`#${section}.userscript-unavailable`);
            return Boolean(notice?.textContent?.includes('油猴脚本暂不支持此功能'))
              && !notice.querySelector('input, button, [role="switch"]');
          }, id);
          if (!unavailable) throw new Error(`${id} 仍显示无法生效的油猴设置控件`);
        }
        visitedSections.push(id);
      }
      for (const [id, noticeId, unsupportedControl] of [
        ['settings-translation', 'context-menu', '.context-menu-preview'],
        ['settings-interface', 'popup-layout', '[data-popup-layout-workbench]'],
      ]) {
        await page.evaluate((section) => {
          window.__fluentReadUserscriptSettingsShadow.querySelector(`button[data-section="${section}"]`).click();
        }, id);
        await page.waitForFunction(({section, notice}) => {
          const root = window.__fluentReadUserscriptSettingsShadow;
          return root?.querySelector(`button[data-section="${section}"]`)?.getAttribute('aria-current') === 'page'
            && Boolean(root.querySelector(`[data-userscript-unavailable="${notice}"]`));
        }, {section: id, notice: noticeId}, {timeout: args.timeout});
        const embeddedAvailability = await page.evaluate(({notice, selector}) => {
          const root = window.__fluentReadUserscriptSettingsShadow;
          const content = root.querySelector(`[data-userscript-unavailable="${notice}"]`);
          return {
            unavailableMessage: content?.textContent?.includes('此功能需要浏览器扩展的运行环境'),
            unsupportedControl: Boolean(root.querySelector(selector)),
          };
        }, {notice: noticeId, selector: unsupportedControl});
        if (!embeddedAvailability.unavailableMessage || embeddedAvailability.unsupportedControl) {
          throw new Error(`${id} 的扩展专属控件处理异常：${JSON.stringify(embeddedAvailability)}`);
        }
        visitedSections.push(id);
      }
      const hostAfter = await page.evaluate(() => ({
        hash: location.hash,
        title: document.title,
        rootClass: document.documentElement.className,
        rootStyle: document.documentElement.getAttribute('style'),
        rootSkin: document.documentElement.dataset.interfaceSkin,
      }));
      if (JSON.stringify(hostBefore) !== JSON.stringify(hostAfter)) {
        throw new Error(`设置主题污染了宿主文档：${JSON.stringify({hostBefore, hostAfter})}`);
      }
      await page.evaluate(() => {
        window.__fluentReadUserscriptSettingsShadow.querySelector('button[data-section="settings-services"]').click();
      });
      await page.waitForFunction(() => {
        const root = window.__fluentReadUserscriptSettingsShadow;
        return root?.querySelector('button[data-section="settings-services"]')?.getAttribute('aria-current') === 'page'
          && Boolean(root.querySelector('#settings-services'));
      }, undefined, {timeout: args.timeout});
      if (await page.evaluate(() => location.hash) !== '#host-route') {
        throw new Error('页内设置导航改写了宿主网页路由');
      }
      await page.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow
        ?.querySelector('[data-testid="free-translation-weight-summary"]'), undefined, {timeout: args.timeout});
      const darkSummaryColor = await page.evaluate(() => getComputedStyle(
        window.__fluentReadUserscriptSettingsShadow.querySelector('[data-testid="free-translation-weight-summary"]'),
      ).backgroundColor);
      const darkSummaryChannels = darkSummaryColor.match(/\d+/g)?.slice(0, 3).map(Number);
      if (!darkSummaryChannels || darkSummaryChannels.some((channel) => channel > 120)) {
        throw new Error(`深色设置仍有浅色权重卡片：${darkSummaryColor}`);
      }
      const ballAfterNavigation = await page.evaluate(() => {
        const ball = document.querySelector('#fluent-read-floating-ball-container');
        return ball ? {
          suspended: ball.getAttribute('data-fluent-read-ui-suspended'),
          computedVisibility: getComputedStyle(ball).visibility,
        } : null;
      });
      if (ballAfterNavigation?.suspended !== 'true' || ballAfterNavigation.computedVisibility !== 'hidden') {
        throw new Error(`设置页导航后悬浮球重新露出：${JSON.stringify(ballAfterNavigation)}`);
      }
      await page.screenshot({path: path.join(artifactsDir, 'userscript-full-options.png'), fullPage: false});
      await page.setViewportSize({width: 390, height: 844});
      const ballAtNarrow = await page.evaluate(() => {
        const ball = document.querySelector('#fluent-read-floating-ball-container');
        return ball ? getComputedStyle(ball).visibility : null;
      });
      if (ballAtNarrow !== 'hidden') throw new Error(`窄屏设置页悬浮球重新露出：${ballAtNarrow}`);
      const narrow = await page.evaluate(() => {
        const app = window.__fluentReadUserscriptSettingsShadow.querySelector('.settings-app');
        return {width: innerWidth, appWidth: app.getBoundingClientRect().width, scrollWidth: app.scrollWidth};
      });
      await page.screenshot({path: path.join(artifactsDir, 'userscript-full-options-narrow.png'), fullPage: false});
      if (narrow.appWidth > narrow.width + 2 || narrow.scrollWidth > narrow.width + 2) {
        throw new Error(`窄屏完整设置页横向溢出：${JSON.stringify(narrow)}`);
      }
      const section = await page.evaluate(() => window.__fluentReadUserscriptSettingsShadow
        .querySelector('button[data-section="settings-services"]')?.textContent?.trim());
      await page.evaluate(() => {
        const closeButton = window.__fluentReadUserscriptSettingsShadow.querySelector('button.userscript-settings-close');
        if (closeButton?.getAttribute('aria-label') !== '关闭') throw new Error('页内完整设置缺少可访问的关闭按钮');
        closeButton.click();
      });
      await settingsHost.waitFor({state: 'detached', timeout: args.timeout});
      const ballAfterClose = await page.evaluate(() => {
        const ball = document.querySelector('#fluent-read-floating-ball-container');
        return ball ? getComputedStyle(ball).visibility : null;
      });
      if (ballAfterClose !== 'visible') throw new Error(`关闭页内设置后悬浮球没有恢复：${ballAfterClose}`);
      const evidence = {initial, hostBefore, hostAfter, savedTheme: decodeStoredValue(sharedGmStore.get('local:config')).theme,
        darkSummaryColor, dropdownInsideShadow, narrow, visitedSections, ballDuringSettings, ballAfterNavigation,
        ballAtNarrow, ballAfterClose,
        section, launchMode, focusPolicy, windowPlacement,
        transport: 'local fixture with deterministic GM shim; no live provider or userscript manager certification'};
      fs.writeFileSync(path.join(artifactsDir, 'options-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      if (consoleErrors.length) throw new Error(`浏览器控制台出现错误：${JSON.stringify(consoleErrors)}`);
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }

    // Keep UI draft/persistence checks isolated from the translation smoke fixture.
    if (args.suite === 'selects' || args.suite === 'compact-save') {
      // Observe only the fixture's settings root; production still uses a closed ShadowRoot.
      async function openSettings() {
        await page.evaluate(() => {
          const original = Element.prototype.attachShadow;
          window.__fluentReadUserscriptSettingsShadow = null;
          window.__fluentReadRestoreSettingsObserver = () => { Element.prototype.attachShadow = original; };
          Element.prototype.attachShadow = function captureSettingsRoot(init) {
            const root = original.call(this, init);
            if (this.getAttribute('data-fluent-read-userscript-host') === 'fluent-read-userscript-settings-ui') {
              window.__fluentReadUserscriptSettingsShadow = root;
            }
            return root;
          };
          window.dispatchEvent(new CustomEvent('fluentread-userscript-open-settings'));
        });
        try {
          await page.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow?.querySelector('input[aria-label="服务"]'), undefined, {timeout: args.timeout});
        } finally {
          await page.evaluate(() => window.__fluentReadRestoreSettingsObserver());
        }
      }
      async function closeSettings() {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('fluentread-userscript-close-settings')));
        await page.locator('#fluent-read-userscript-settings-container').waitFor({state: 'detached', timeout: args.timeout});
      }
      async function openSelect(label) {
        await page.evaluate((label) => {
          const input = window.__fluentReadUserscriptSettingsShadow.querySelector(`input[aria-label="${label}"]`);
          input.scrollIntoView({block: 'center'});
          input.closest('.el-select__wrapper').click();
          input.focus();
        }, label);
        await page.waitForFunction(() => [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-popper.fluentread-select-popper')].some(menu => menu.getBoundingClientRect().height > 0));
        await page.waitForTimeout(220);
      }
      async function chooseOption(label, text) {
        await openSelect(label);
        await page.evaluate((text) => {
          const root = window.__fluentReadUserscriptSettingsShadow;
          const option = [...root.querySelectorAll('.el-popper .el-select-dropdown__item')].find(item => item.getBoundingClientRect().height && item.textContent.trim() === text);
          if (!option) throw new Error(`找不到选项：${text}`);
          option.click();
        }, text);
      }
      async function saveSettings() {
        await page.evaluate(() => window.__fluentReadUserscriptSettingsShadow.querySelector('footer .primary').click());
        await page.waitForFunction(() => {
          const status = window.__fluentReadUserscriptSettingsShadow.querySelector('.status');
          return status?.textContent.includes('本次提交已保存') && !status.classList.contains('error');
        });
      }
      await openSettings();
      const settingsHost = page.locator('#fluent-read-userscript-settings-container');
      const settingsSecurity = await settingsHost.evaluate((host) => ({closedShadow: host.shadowRoot === null, lightDomText: host.textContent || ''}));
      if (!settingsSecurity.closedShadow || settingsSecurity.lightDomText.trim()) throw new Error('设置面板未使用 closed Shadow DOM');
      if (args.suite === 'compact-save') {
        const uiTimeout = Math.min(args.timeout, 15_000);
        page.setDefaultTimeout(uiTimeout);
        const stored = () => decodeStoredValue(sharedGmStore.get('local:config'));
        const readFields = () => page.evaluate(() => Object.fromEntries(['服务', '译文显示', '双语样式'].map(label => {
          const select = window.__fluentReadUserscriptSettingsShadow.querySelector(`input[aria-label="${label}"]`)?.closest('.fluentread-select');
          return [label, select?.querySelector('.el-select__placeholder')?.textContent.trim() || ''];
        })));
        const storedState = () => ({service: stored().service, display: stored().display, style: stored().style,
          hasDisplay: Object.hasOwn(stored(), 'display'), hasStyle: Object.hasOwn(stored(), 'style')});
        const waitForHydratedPanel = () => page.waitForFunction(() => {
          const root = window.__fluentReadUserscriptSettingsShadow;
          return root?.querySelector('footer .primary')?.disabled === false && ['服务', '译文显示', '双语样式'].every(label =>
            root.querySelector(`input[aria-label="${label}"]`)?.closest('.fluentread-select')?.querySelector('.el-select__placeholder')?.textContent.trim());
        }, undefined, {timeout: uiTimeout});
        await waitForHydratedPanel();
        const initial = {ui: await readFields(), ...storedState()};
        const fail = async (message, details = {}) => {
          const diagnostic = {suite: 'compact-save', message, initial, ui: await readFields(), stored: storedState(), ...details};
          const json = JSON.stringify(diagnostic, (_key, value) => value === undefined ? '<absent>' : value, 2);
          fs.writeFileSync(path.join(artifactsDir, 'compact-save-failure.json'), `${json}\n`);
          throw new Error(`${message}: ${json}`);
        };
        const waitForSelectedLabel = async (label, text) => {
          try {
            await page.waitForFunction(({label, text}) => {
              const root = window.__fluentReadUserscriptSettingsShadow;
              const input = root.querySelector(`input[aria-label="${label}"]`);
              const select = input?.closest('.fluentread-select');
              // 本专项等待实际选择值，菜单挂载及关闭行为仍由独立 selects 专项检查。
              return select?.querySelector('.el-select__placeholder')?.textContent.trim() === text;
            }, {label, text}, {timeout: uiTimeout});
          } catch (error) {await fail('选项点击后公开标签尚未结算', {label, expected: text, cause: error.message});}
        };
        const chooseCompactOption = async (label, text) => {
          await openSelect(label);
          if (label === '服务') {
            await page.keyboard.type(text);
            await page.waitForFunction(text => {
              const items = [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-select-dropdown__item')]
                .filter(item => item.getBoundingClientRect().height > 0);
              return items.length === 1 && items[0].textContent.trim() === text;
            }, text, {timeout: uiTimeout});
            await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
          } else {
            const point = await page.evaluate(text => {
              const root = window.__fluentReadUserscriptSettingsShadow;
              const option = [...root.querySelectorAll('.el-popper .el-select-dropdown__item')]
                .find(item => item.getBoundingClientRect().height > 0 && item.textContent.trim() === text);
              if (!option) throw new Error(`找不到可见选项：${text}`);
              option.scrollIntoView({block: 'nearest', inline: 'nearest'});
              const bounds = option.getBoundingClientRect();
              const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
              if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) throw new Error(`选项点击位置不在视口内：${text}`);
              return {x, y};
            }, text);
            await page.mouse.click(point.x, point.y);
          }
          await waitForSelectedLabel(label, text);
        };
        const cases = [];
        await chooseCompactOption('服务', 'DeepSeek');
        const serviceDraft = await readFields();
        if (stored().service !== initial.service) await fail('服务草稿尚未点击保存就被提交');
        await closeSettings(); await openSettings(); await waitForHydratedPanel(); await waitForSelectedLabel('服务', initial.ui['服务']);
        const discarded = await readFields();
        if (stored().service !== initial.service) await fail('关闭后重开改变了持久化服务');
        if (discarded['服务'] !== initial.ui['服务']) await fail('关闭后重开没有丢弃未保存的服务草稿');
        cases.push({name: 'discard-unsaved-service', passed: true, draft: serviceDraft['服务'], reopened: discarded['服务'], storedService: stored().service});

        await chooseCompactOption('译文显示', '仅译文模式');
        const displayDraft = await readFields();
        if (stored().display !== initial.display) await fail('译文显示尚未点击保存就被提交');
        await saveSettings();
        if (stored().display !== 0 || stored().service !== initial.service) throw new Error('手动保存译文显示失败，或回灌了已取消的服务草稿');
        cases.push({name: 'save-display', passed: true, before: initial.display, draft: displayDraft['译文显示'], storedDisplay: stored().display});

        const beforeStyle = stored().style;
        if (initial.style === 2 || beforeStyle === 2) await fail('测试初始样式已经是优雅斜体，无法证明手动保存发生变更', {beforeStyle});
        await chooseCompactOption('双语样式', '优雅斜体');
        const styleDraft = await readFields();
        if (stored().style !== beforeStyle) await fail('双语样式尚未点击保存就被提交', {beforeStyle});
        await saveSettings();
        if (stored().style !== 2 || stored().display !== 0 || stored().service !== initial.service) throw new Error('手动保存双语样式失败，或覆盖了前一次提交');
        cases.push({name: 'save-style', passed: true, before: beforeStyle, draft: styleDraft['双语样式'], storedStyle: stored().style});

        await closeSettings(); await openSettings(); await waitForHydratedPanel();
        await waitForSelectedLabel('译文显示', '仅译文模式'); await waitForSelectedLabel('双语样式', '优雅斜体');
        const reopened = await readFields();
        if (!reopened['译文显示'].includes('仅译文模式') || !reopened['双语样式'].includes('优雅斜体')
          || reopened['服务'] !== initial.ui['服务'] || stored().display !== 0 || stored().style !== 2) throw new Error(`保存后重开丢失设置：${JSON.stringify(reopened)}`);
        cases.push({name: 'reopen-saved-settings', passed: true, reopened, stored: {service: stored().service, display: stored().display, style: stored().style}});
        await page.screenshot({path: path.join(artifactsDir, 'userscript-compact-save-reopened.png'), fullPage: false});
        await closeSettings();
        const evidence = {suite: 'compact-save', cases, settingsSecurity, initial, consoleErrors, launchMode, focusPolicy, windowPlacement,
          scope: 'manual save and draft disposal only; this result does not certify the separate selects suite',
          excludedChecks: ['selects menuOutsideScrollArea, dark-menu and narrow-menu layout assertions remain unchanged in --suite selects'],
          transport: 'local fixture with deterministic GM shim; no live provider or userscript manager certification'};
        fs.writeFileSync(path.join(artifactsDir, 'compact-save-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        if (consoleErrors.length) throw new Error(`浏览器控制台出现错误：${JSON.stringify(consoleErrors)}`);
        console.log(JSON.stringify(evidence, null, 2));
        return;
      }
      await openSelect('服务');
      const settingsSelectState = await page.evaluate(() => {
        const root = window.__fluentReadUserscriptSettingsShadow;
        const menu = [...root.querySelectorAll('.el-popper.fluentread-select-popper')].find(menu => menu.getBoundingClientRect().height);
        const bounds = menu.getBoundingClientRect();
        const service = root.querySelector('input[aria-label="服务"]').closest('.fluentread-select');
        return {
          visibleSelectCount: root.querySelectorAll('.fluentread-select').length,
          nativeSelectCount: root.querySelectorAll('select').length,
          unexpectedNativeSelects: [...root.querySelectorAll('select')]
            .filter((select) => select.getAttribute('aria-label') !== '免费翻译选择模式')
            .map((select) => select.outerHTML.slice(0, 300)),
          menuInsideShadow: menu.getRootNode() === root,
          menuInsideBackdrop: root.querySelector('.fr-userscript-settings-backdrop').contains(menu),
          menuOutsideScrollArea: !menu.closest('.settings-grid, .fr-userscript-settings'),
          menuInsideViewport: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
          inputCount: service.querySelectorAll('input').length,
          triggerLabelWhileOpen: service.querySelector('.el-select__placeholder')?.textContent.trim(),
        };
      });
      await page.screenshot({path: path.join(artifactsDir, 'userscript-service-menu.png')});
      if (settingsSelectState.visibleSelectCount < 12 || settingsSelectState.unexpectedNativeSelects.length !== 0
        || !settingsSelectState.menuInsideShadow || !settingsSelectState.menuInsideBackdrop
        || !settingsSelectState.menuOutsideScrollArea || !settingsSelectState.menuInsideViewport
        || settingsSelectState.inputCount !== 1 || settingsSelectState.triggerLabelWhileOpen !== '搜索翻译服务') {
        throw new Error(`userscript 菜单隔离断言失败：${JSON.stringify(settingsSelectState)}`);
      }
      await page.keyboard.type('DeepSeek');
      await page.waitForFunction(() => {
        const items = [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-select-dropdown__item')].filter(item => item.getBoundingClientRect().height);
        return items.length === 1 && items[0].textContent.includes('DeepSeek');
      });
      await page.screenshot({path: path.join(artifactsDir, 'userscript-service-search.png')});
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__fluentReadUserscriptSettingsShadow.querySelector('input[aria-label="服务"]').closest('.fluentread-select').textContent.includes('DeepSeek'));
      await closeSettings();
      if (decodeStoredValue(sharedGmStore.get('local:config')).service !== 'freeTranslation') throw new Error('关闭设置意外保存草稿');
      await openSettings();
      await chooseOption('译文显示', '仅译文模式');
      await chooseOption('双语样式', '加粗显示');
      await saveSettings();
      const savedConfig = decodeStoredValue(sharedGmStore.get('local:config'));
      const settingsDraftState = {canceledServicePreserved: true, savedDisplay: savedConfig.display, savedStyle: savedConfig.style};
      if (savedConfig.display !== 0 || savedConfig.style !== 1) throw new Error(`数值选项保存错误：${JSON.stringify(settingsDraftState)}`);
      await closeSettings();
      await openSettings();
      const reopenedDisplay = await page.evaluate(() => window.__fluentReadUserscriptSettingsShadow.querySelector('input[aria-label="译文显示"]').closest('.fluentread-select').textContent);
      if (!reopenedDisplay.includes('仅译文模式')) throw new Error(`保存重开丢失选项：${reopenedDisplay}`);
      settingsDraftState.reopenedDisplay = reopenedDisplay.trim();
      // Restore the bilingual fixture mode before the original translation smoke checks.
      await chooseOption('译文显示', '双语对照模式');
      await saveSettings();
      await chooseOption('主题', '暗色主题');
      await openSelect('服务');
      const darkMenuColor = await page.evaluate(() => {
        const root = window.__fluentReadUserscriptSettingsShadow;
        return getComputedStyle([...root.querySelectorAll('.el-popper.fluentread-select-popper')].find(menu => menu.getBoundingClientRect().height)).backgroundColor;
      });
      await page.screenshot({path: path.join(artifactsDir, 'userscript-service-dark.png')});
      if (darkMenuColor === 'rgb(255, 255, 255)') throw new Error('深色设置菜单仍显示白色');
      await closeSettings();
      await page.setViewportSize({width: 390, height: 844});
      await openSettings();
      await chooseOption('主题', '暗色主题');
      await openSelect('服务');
      await page.screenshot({path: path.join(artifactsDir, 'userscript-service-narrow.png')});
      const narrowBounds = await page.evaluate(() => {
        const menu = [...window.__fluentReadUserscriptSettingsShadow.querySelectorAll('.el-popper.fluentread-select-popper')].find(menu => menu.getBoundingClientRect().height);
        const r = menu.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight};
      });
      if (narrowBounds.left < 0 || narrowBounds.right > narrowBounds.width || narrowBounds.top < 0 || narrowBounds.bottom > narrowBounds.height) throw new Error(`窄屏菜单越界：${JSON.stringify(narrowBounds)}`);
      await closeSettings();
      await page.setViewportSize({width: 1280, height: 900});
      const selectEvidence = {settingsSecurity, settingsSelectState, settingsDraftState, search: 'DeepSeek', keyboardSelection: true, darkMenuColor, narrowBounds, consoleErrors, launchMode, focusPolicy, windowPlacement, transport: 'local fixture with deterministic GM shim; no live provider or userscript manager certification'};
      fs.writeFileSync(path.join(artifactsDir, 'select-evidence.json'), `${JSON.stringify(selectEvidence, null, 2)}\n`);
      if (consoleErrors.length) throw new Error(`浏览器控制台出现错误：${JSON.stringify(consoleErrors)}`);
      console.log(JSON.stringify(selectEvidence, null, 2));
      return;
    }

    await page.evaluate(() => {
      const originalOpen = window.open;
      window.open = () => null; // Test the same-page fallback before continuing translation checks.
      try {
        window.dispatchEvent(new CustomEvent('fluentread-userscript-open-settings'));
      } finally {
        window.open = originalOpen;
      }
    });
    const settingsHost = page.locator('#fluent-read-userscript-settings-container');
    await settingsHost.waitFor({state: 'attached', timeout: args.timeout});
    const settingsSecurity = await settingsHost.evaluate((host) => ({
      closedShadow: host.shadowRoot === null,
      lightDomText: host.textContent || '',
    }));
    if (!settingsSecurity.closedShadow || settingsSecurity.lightDomText.trim()) {
      throw new Error(`设置面板 Shadow DOM 隔离失败：${JSON.stringify(settingsSecurity)}`);
    }
    await page.screenshot({path: path.join(artifactsDir, 'userscript-settings.png'), fullPage: false});
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fluentread-userscript-close-settings')));
    await settingsHost.waitFor({state: 'detached', timeout: args.timeout});

    await page.locator('#unsupported-image').hover();
    const unsupportedHosts = await page.evaluate(() => ({
      area: Boolean(document.querySelector('#fluent-read-area-translator-container')),
      image: Boolean(document.querySelector('#fluent-read-image-translation-root')),
      video: Boolean(document.querySelector('#fluent-read-video-subtitle-style')),
    }));
    if (unsupportedHosts.area || unsupportedHosts.image || unsupportedHosts.video) {
      throw new Error(`扩展专属能力不应在 userscript 挂载：${JSON.stringify(unsupportedHosts)}`);
    }

    const hoverCounts = [];
    await hoverToggle(page, 1, args.timeout); hoverCounts.push((await readState(page)).target);
    const hoverFirst = await readState(page);
    if (hoverFirst.adjacent !== 0 || !/[\u3400-\u9fff]/u.test(hoverFirst.targetTranslation)) {
      throw new Error(`hover 翻译断言失败：${JSON.stringify(hoverFirst)}`);
    }
    await hoverToggle(page, 0, args.timeout); hoverCounts.push((await readState(page)).target);
    await hoverToggle(page, 1, args.timeout); hoverCounts.push((await readState(page)).target);
    await hoverToggle(page, 0, args.timeout);

    const fullPageCounts = [];
    await page.keyboard.down('Alt');
    await page.keyboard.press('t');
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => Boolean(document.querySelector('#adjacent .fluent-read-loading')), undefined, {
      timeout: args.timeout,
    });
    const userscriptLoadingStyle = await page.evaluate(() => {
      const host = document.querySelector('#adjacent .fluent-read-loading');
      if (!(host instanceof HTMLElement)) return null;
      const rect = host.getBoundingClientRect();
      const computed = getComputedStyle(host);
      const before = getComputedStyle(host, '::before');
      const after = getComputedStyle(host, '::after');
      return {
        style: host.getAttribute('data-fr-loading-style'),
        motion: host.getAttribute('data-fr-motion'),
        closedShadowRoot: host.shadowRoot === null,
        width: rect.width,
        height: rect.height,
        display: computed.display,
        opacity: computed.opacity,
        visibility: computed.visibility,
        transform: computed.transform,
        animationName: computed.animationName,
        before: {content: before.content, display: before.display},
        after: {content: after.content, display: after.display},
        widthPriority: host.style.getPropertyPriority('width'),
        animationPriority: host.style.getPropertyPriority('animation'),
      };
    });
    if (!userscriptLoadingStyle
      || userscriptLoadingStyle.style !== 'orbit'
      || userscriptLoadingStyle.motion !== 'animated'
      || !userscriptLoadingStyle.closedShadowRoot
      || userscriptLoadingStyle.width !== 16
      || userscriptLoadingStyle.height !== 16
      || userscriptLoadingStyle.display !== 'inline-flex'
      || userscriptLoadingStyle.opacity !== '1'
      || userscriptLoadingStyle.visibility !== 'visible'
      || userscriptLoadingStyle.transform !== 'none'
      || userscriptLoadingStyle.animationName !== 'none'
      || userscriptLoadingStyle.before.content !== 'none'
      || userscriptLoadingStyle.before.display !== 'none'
      || userscriptLoadingStyle.after.content !== 'none'
      || userscriptLoadingStyle.after.display !== 'none'
      || userscriptLoadingStyle.widthPriority !== 'important'
      || userscriptLoadingStyle.animationPriority !== 'important') {
      throw new Error(`userscript 段落加载样式未隔离宿主页：${JSON.stringify(userscriptLoadingStyle)}`);
    }
    await Promise.all([
      waitForCount(page, '#target', 1, args.timeout),
      waitForCount(page, '#adjacent', 1, args.timeout),
      waitForCount(page, '#heading', 1, args.timeout),
      waitForShadowCount(page, '#shadow-host', '#shadow-paragraph', 1, args.timeout),
    ]);
    fullPageCounts.push([1, 1]);
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'dynamic-paragraph';
      paragraph.textContent = 'Dynamic content should join the active translation session.';
      document.querySelector('#dynamic-root').appendChild(paragraph);

      const host = document.createElement('div');
      host.id = 'dynamic-shadow-host';
      document.querySelector('main').appendChild(host);
      const shadow = host.attachShadow({mode: 'open'});
      shadow.innerHTML = '<p id="dynamic-shadow-paragraph">A shadow root created after injection should be translated.</p>';

      history.pushState({fixture: true}, '', `${location.pathname}?route=userscript-smoke`);
      history.replaceState({fixture: true}, '', location.pathname);
    });
    await Promise.all([
      waitForCount(page, '#target', 1, args.timeout),
      waitForCount(page, '#adjacent', 1, args.timeout),
      waitForCount(page, '#heading', 1, args.timeout),
      waitForShadowCount(page, '#shadow-host', '#shadow-paragraph', 1, args.timeout),
      waitForCount(page, '#dynamic-paragraph', 1, args.timeout),
      waitForShadowCount(page, '#dynamic-shadow-host', '#dynamic-shadow-paragraph', 1, args.timeout),
    ]);
    const bridgeEvents = await page.evaluate(() => ({...window.__fluentReadSmokeBridgeEvents}));
    if (bridgeEvents.shadow < 1 || bridgeEvents.route < 2) {
      throw new Error(`Shadow/SPA bridge 事件断言失败：${JSON.stringify(bridgeEvents)}`);
    }
    const fullFirst = await readState(page);
    if (fullFirst.heading !== 1 || fullFirst.nav !== 0 || fullFirst.shadow !== 1
      || fullFirst.dynamic !== 1 || fullFirst.dynamicShadow !== 1) {
      throw new Error(`全文翻译覆盖断言失败：${JSON.stringify(fullFirst)}`);
    }
    await fullPageToggle(page, 0, 0, args.timeout); fullPageCounts.push([0, 0]);
    const restored = await readState(page);
    if (restored.heading || restored.shadow || restored.dynamic || restored.dynamicShadow) {
      throw new Error(`全文恢复有残留：${JSON.stringify(restored)}`);
    }
    await fullPageToggle(page, 1, 1, args.timeout); fullPageCounts.push([1, 1]);
    const finalState = await readState(page);
    if (finalState.url !== fixture.url || finalState.target !== 1 || finalState.adjacent !== 1) {
      throw new Error(`最终状态断言失败：${JSON.stringify(finalState)}`);
    }
    await page.screenshot({path: path.join(artifactsDir, 'userscript-translated.png'), fullPage: true});

    await fullPageToggle(page, 0, 0, args.timeout);
    await page.waitForTimeout(700);
    const concurrentPages = [];
    let crossTabCount;
    try {
      const createCountingPage = async () => {
        const countingPage = await createIsolatedPage();
        concurrentPages.push(countingPage);
        countingPage.on('pageerror', (error) => consoleErrors.push(`cross-tab pageerror: ${error.message}`));
        countingPage.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`cross-tab console: ${message.text()}`);
        });
        await countingPage.goto(fixture.url, {waitUntil: 'domcontentloaded', timeout: args.timeout});
        await countingPage.evaluate(() => {
          localStorage.setItem('__fluentReadHostLocalSentinel', 'host-local-sentinel');
          sessionStorage.setItem('__fluentReadHostSessionSentinel', 'host-session-sentinel');
        });
        await preloadUserscriptRequires(countingPage, artifact);
        await countingPage.addScriptTag({path: artifact});
        await countingPage.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: args.timeout});
        await countingPage.waitForSelector('#fluent-read-floating-ball-container', {state: 'attached', timeout: args.timeout});
        return countingPage;
      };

      const baseline = readSharedUserscriptCount(sharedGmStore);
      const firstCountingPage = await createCountingPage();
      const secondCountingPage = await createCountingPage();
      await Promise.all([
        hoverToggle(firstCountingPage, 1, args.timeout),
        hoverToggle(secondCountingPage, 1, args.timeout),
      ]);
      await firstCountingPage.waitForTimeout(800);
      const afterConcurrentTranslation = readSharedUserscriptCount(sharedGmStore);
      if (afterConcurrentTranslation !== baseline + 2) {
        throw new Error(`userscript 跨标签计数丢失：${JSON.stringify({baseline, afterConcurrentTranslation})}`);
      }
      await Promise.all(concurrentPages.splice(0).map((countingPage) => countingPage.close()));

      const recoveryPage = await createCountingPage();
      const recovered = await recoveryPage.evaluate(async () => {
        const rawConfig = await window.__fluentReadGmGet('local:config', null);
        const parsedConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
        return {
          count: parsedConfig?.count,
          localSentinel: localStorage.getItem('__fluentReadHostLocalSentinel'),
          sessionSentinel: sessionStorage.getItem('__fluentReadHostSessionSentinel'),
        };
      });
      const countEntries = [...sharedGmStore.entries()].filter(([key]) => key.startsWith('fluentread:count:v1:'));
      const countPayload = JSON.stringify(countEntries);
      if (recovered.count !== afterConcurrentTranslation) {
        throw new Error(`userscript 新页面没有恢复权威计数：${JSON.stringify({recovered, afterConcurrentTranslation})}`);
      }
      await recoveryPage.waitForTimeout(250);
      const stableRecoveredCount = await recoveryPage.evaluate(async () => {
        const rawConfig = await window.__fluentReadGmGet('local:config', null);
        const parsedConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
        return parsedConfig?.count;
      });
      if (stableRecoveredCount !== afterConcurrentTranslation) {
        throw new Error(`userscript 权威计数被迟到初始化回滚：${JSON.stringify({
          stableRecoveredCount,
          afterConcurrentTranslation,
        })}`);
      }
      if (recovered.localSentinel !== 'host-local-sentinel' || recovered.sessionSentinel !== 'host-session-sentinel') {
        throw new Error(`userscript 计数污染宿主 Web Storage：${JSON.stringify(recovered)}`);
      }
      if (countPayload.includes(fixture.url)
        || countPayload.includes('FluentRead keeps the original paragraph')
        || countPayload.includes('credential-sentinel')) {
        throw new Error('userscript 计数 GM 键或记录包含页面证据或凭据');
      }
      crossTabCount = {
        baseline,
        afterConcurrentTranslation,
        recoveredCount: recovered.count,
        countKeyCount: countEntries.length,
        hostStoragePreserved: true,
      };
    } finally {
      await Promise.all(concurrentPages.map((countingPage) => countingPage.close().catch(() => undefined)));
    }

    await page.evaluate(() => {
      return window.__fluentReadGmGet('local:config', null).then((rawConfig) => {
        const nextConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
        nextConfig.service = 'openai';
        nextConfig.token = {...nextConfig.token, openai: ''};
        return window.__fluentReadGmSet('local:config', JSON.stringify(nextConfig));
      }).then(() => {
        window.dispatchEvent(new Event('focus'));
      });
    });
    await page.waitForTimeout(80);
    await hoverToggle(page, 0, args.timeout);
    const message = page.locator('body > .el-message.fluent-read-message').last();
    let messageStyle;
    if (await message.count() > 0 && await message.isVisible().catch(() => false)) {
      messageStyle = await message.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          kind: 'light-dom-message',
          lightDom: element.getRootNode() === document,
          position: style.position,
          display: style.display,
          zIndex: style.zIndex,
          top: rect.top,
          width: rect.width,
        };
      });
      if (!messageStyle.lightDom || messageStyle.position !== 'fixed' || messageStyle.display !== 'flex'
        || Number(messageStyle.zIndex) < 2_147_483_000 || messageStyle.top < 0 || messageStyle.width < 100) {
        throw new Error(`light-DOM 错误提示样式断言失败：${JSON.stringify(messageStyle)}`);
      }
    } else {
      const retry = page.locator('#target .fluent-read-retry-wrapper').last();
      await retry.waitFor({state: 'visible', timeout: args.timeout});
      messageStyle = await retry.evaluate((element) => ({
        kind: 'inline-retry-wrapper',
        lightDom: element.getRootNode() === document,
        text: element.textContent?.trim() || '',
      }));
      if (!messageStyle.lightDom || !messageStyle.text) {
        throw new Error(`inline 错误提示断言失败：${JSON.stringify(messageStyle)}`);
      }
    }

    const bridgeCleanup = await page.evaluate(async () => {
      const host = document.createElement('div');
      host.id = 'post-dispose-shadow-host';
      document.querySelector('main').appendChild(host);
      const before = {...window.__fluentReadSmokeBridgeEvents};
      document.dispatchEvent(new CustomEvent('fluentread-shadow-bridge-dispose'));
      const prototypeRestored = Element.prototype.attachShadow === window.__fluentReadOriginalAttachShadow;
      host.attachShadow({mode: 'open'}).innerHTML = '<p>Created after bridge cleanup.</p>';
      history.pushState({disposed: true}, '', `${location.pathname}?after-dispose=1`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        before,
        after: {...window.__fluentReadSmokeBridgeEvents},
        prototypeRestored,
      };
    });
    if (!bridgeCleanup.prototypeRestored
      || bridgeCleanup.after.shadow !== bridgeCleanup.before.shadow
      || bridgeCleanup.after.route !== bridgeCleanup.before.route) {
      throw new Error(`Shadow/SPA bridge 清理断言失败：${JSON.stringify(bridgeCleanup)}`);
    }

    await page.screenshot({path: path.join(artifactsDir, 'userscript-final.png'), fullPage: true});
    const evidence = {
      browser: args.engine === 'webkit' ? 'Playwright WebKit' : path.basename(args.browserPath),
      isolatedProfile: args.engine === 'webkit' ? null : profileDir,
      artifact,
      fixtureUrl: fixture.url,
      transport: `${args.gmMode} GM deterministic browser shim`,
      gmMode: args.gmMode,
      preloadedRequires,
      hoverCounts,
      fullPageCounts,
      finalState,
      pageGlobalsPreserved,
      hostDexie,
      reinjectionState: {...reinjectionState, gmStoreUnchanged: true},
      settingsSecurity,
      userscriptLoadingStyle,
      unsupportedHosts,
      bridgeEvents,
      crossTabCount,
      messageStyle,
      bridgeCleanup,
      consoleErrors,
      launchMode,
      focusPolicy,
      windowPlacement,
    };
    fs.writeFileSync(path.join(artifactsDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    if (consoleErrors.length) throw new Error(`浏览器控制台出现错误：${JSON.stringify(consoleErrors)}`);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {primaryError = error; throw error;} finally {
    const cleanupErrors = [];
    const cleanup = async release => {
      try {await release();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    let profileRemoved = false;
    await cleanup(async () => {
      if (closeBrowser) {await closeBrowser(); browserClosed = true;}
    });
    await cleanup(async () => {await fixture.close();});
    await cleanup(async () => {
      if (profileDir && browserClosed) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            fs.rmSync(profileDir, {recursive: true, force: true});
            profileRemoved = true;
            break;
          } catch (error) {
            if (attempt === 4) console.error(`userscript 临时 profile 清理警告：${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      } else if (profileDir && !launchAttempted) {
        try {fs.rmdirSync(profileDir); profileRemoved = true;} catch { /* Retain nonempty profiles before any attempted launch. */ }
      }
    });
    if (profileDir && !profileRemoved) console.error(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}`);
    for (const error of cleanupErrors) console.error(`Cleanup failed: ${error.stack || error}`);
    if (cleanupErrors.length) process.exitCode = 1;
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs, selectUserscriptTestPage};
