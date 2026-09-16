'use strict';

// 翻译统计生产产物专项：临时 Edge profile + macOS 防抢焦点后台窗口 + 本地 DeepLX/OpenAI 兼容夹具。
// 翻译请求走真实 runtime 消息、broker、IndexedDB 仓库与设置页面板，不访问外部翻译服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(argument('playwright-root', ''));
const focusHelper = path.resolve(argument('focus-safe-helper', ''));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-translation-stats-ui'));
const browserPath = argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const timeout = Number(argument('timeout', '30000'));
const panel = '#settings-translation-stats';
const AI_SERVICE = 'custom:stats-fixture';
const FIXTURE_WORDS = ['alpha', 'bravo', 'charlie', 'exceeded', 'golf', 'hotel', 'india', 'juliet', 'kilo', '译:'];

assert.equal(process.platform, 'darwin', '本专项仅使用 macOS 隔离 Edge 防抢焦点流程');
assert.ok(fs.existsSync(focusHelper), `防抢焦点 helper 不存在：${focusHelper}`);
assert.ok(fs.existsSync(path.join(extensionDir, 'manifest.json')), `扩展产物不存在：${extensionDir}`);
assert.ok(!extensionDir.endsWith('-dev'), '本专项必须使用 production 扩展产物');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.ok(!manifest.name.includes('DEV'), '不接受开发扩展作为 production 验证');
const optionsPath = manifest.options_page || manifest.options_ui?.page;
assert.ok(optionsPath, '清单必须声明 options 页面');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(focusHelper);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// 配置保存会补齐默认字段，因此只比较补丁里声明的键与数组元素。
const subset = (actual, expected) => Array.isArray(expected)
  ? Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => subset(actual[index], value))
  : expected && typeof expected === 'object'
    ? Boolean(actual) && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
    : JSON.stringify(actual) === JSON.stringify(expected);

function fixtureDelay(text) {
  if (text.includes('slow')) return 1_300;
  if (text.includes('shared')) return 500;
  if (text.includes('medium')) return 350;
  if (text.includes('ai')) return 200;
  return 60;
}

async function startFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.url.startsWith('/deeplx')) {
      const text = String(body.text || '');
      requests.push({kind: 'deeplx', text});
      await wait(fixtureDelay(text));
      response.setHeader('Content-Type', 'application/json');
      if (text.includes('limit')) {
        response.statusCode = 429;
        response.end(JSON.stringify({code: 429, message: 'rate limited'}));
        return;
      }
      response.end(JSON.stringify({code: 200, data: `译:${text}`}));
      return;
    }
    if (request.url.startsWith('/v1/chat/completions')) {
      const prompt = (body.messages || []).filter(item => item.role === 'user').map(item => item.content).join('\n');
      const text = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1] ?? prompt;
      requests.push({kind: 'ai', text});
      await wait(fixtureDelay(text));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        id: 'stats-fixture', object: 'chat.completion', created: 1, model: 'stats-model',
        choices: [{index: 0, message: {role: 'assistant', content: `译:${text}`}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 12, completion_tokens: 6, total_tokens: 18},
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve))};
}

async function assertBackground(context, label) {
  const session = await context.browser().newBrowserCDPSession();
  try {
    const {processInfo} = await session.send('SystemInfo.getProcessInfo');
    const browserPid = processInfo.find(item => item.type === 'browser')?.id;
    assert.ok(Number.isInteger(browserPid), '无法读取测试浏览器精确 PID');
    const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
      "ObjC.import('AppKit');",
      'const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
      'JSON.stringify({pid: Number(app.processIdentifier), name: ObjC.unwrap(app.localizedName)});',
    ].join('\n')], {timeout: 5000});
    const frontmost = JSON.parse(stdout.trim());
    assert.notEqual(frontmost.pid, browserPid, `测试 Edge 成为了前台应用：${label}`);
    return {label, browserPid, frontmost, browserFrontmost: false};
  } finally {
    await session.detach().catch(() => {});
  }
}

async function readConfig(page) {
  return page.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!result?.success) throw new Error(result?.error || 'config read failed');
    return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  });
}

async function patchConfig(page, patch, clientId) {
  const current = await readConfig(page);
  const replace = Object.hasOwn(patch, 'token');
  const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
  const result = await page.evaluate(message => chrome.runtime.sendMessage(message), {
    type: 'persistConfig', mode: replace ? 'replace' : 'patch', config: replace ? {...current, ...patch} : patch, expected,
    baseRevision: replace ? current.__fluentConfigRevision : undefined, clientId, sequence: 1,
  });
  assert.equal(result?.success, true, result?.error);
  let pending = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const config = await readConfig(page);
    pending = Object.entries(patch).filter(([key, value]) => key !== 'token' && !subset(config[key], value)).map(([key]) => key);
    if (pending.length === 0) return;
    await wait(50);
  }
  throw new Error(`配置未收敛：${pending.join(', ')}`);
}

async function translate(page, requests) {
  return page.evaluate(async items => Promise.all(items.map(async ({delayMs = 0, ...message}) => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const response = await chrome.runtime.sendMessage({requestTimeoutMs: 15_000, ...message});
    return response && typeof response === 'object' && !Array.isArray(response) ? {error: response.kind, statusCode: response.statusCode} : {ok: true};
  })), requests);
}

async function refreshPanel(page, expectedRequests) {
  await page.locator(`${panel} .stats-actions .stats-button`).first().click();
  await page.waitForFunction(({selector, expectedRequests}) => {
    const root = document.querySelector(selector);
    const value = root?.querySelector('.stats-summary .stats-card-value')?.textContent || '';
    return root?.querySelector('.stats-summary')?.getAttribute('aria-busy') === 'false'
      && Number(value.replace(/[^0-9]/gu, '')) === expectedRequests;
  }, {selector: panel, expectedRequests}, {timeout});
}

async function selectOption(page, label, optionText) {
  const input = page.locator(`${panel} input[aria-label="${label}"]`);
  await input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]').click();
  const dropdown = page.locator('.el-select-dropdown:visible').first();
  await dropdown.waitFor({state: 'visible', timeout});
  await dropdown.getByRole('option', {name: optionText, exact: true}).click();
  await dropdown.waitFor({state: 'hidden', timeout});
}

async function logRows(page, expectedCount) {
  if (expectedCount !== undefined) {
    await page.waitForFunction(({selector, expectedCount}) => (
      document.querySelector(selector)?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll(`${selector} .stats-log-table tbody tr`).length === expectedCount
    ), {selector: `${panel} .stats-log`, expectedCount}, {timeout});
  }
  return page.locator(`${panel} .stats-log-table tbody tr`).evaluateAll(rows => rows.map(row => ({
    text: row.textContent.replace(/\s+/gu, ' ').trim(),
    source: row.querySelector('.stats-badge')?.className || '',
    duration: row.querySelector('td:last-child strong')?.textContent?.trim() || '',
  })));
}

async function pollRows(page, predicate, label) {
  const deadline = Date.now() + timeout;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await logRows(page);
    if (predicate(rows)) return rows;
    await wait(100);
  }
  throw new Error(`${label}：${JSON.stringify(rows.slice(0, 3))}`);
}

function durationMs(text) {
  const value = Number.parseFloat(text.replace(/,/gu, ''));
  if (/毫秒|ms/u.test(text)) return value;
  if (/分/u.test(text)) return value * 60_000;
  return value * 1_000;
}

async function capture(page, report, name) {
  const file = path.join(artifactsDir, `${name}.png`);
  await page.screenshot({path: file, fullPage: false});
  report.screenshots.push(file);
}

async function measureLayout(page, width, height) {
  await page.setViewportSize({width, height});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await page.evaluate(selector => {
    const root = document.documentElement;
    const dashboard = document.querySelector(selector);
    const rect = dashboard.getBoundingClientRect();
    const cards = [...dashboard.querySelectorAll('.stats-card')].map(card => {
      const bounds = card.getBoundingClientRect();
      return {className: card.className, left: bounds.left, right: bounds.right, overflow: card.scrollWidth > card.clientWidth + 1};
    });
    return {width: innerWidth, documentOverflow: root.scrollWidth > root.clientWidth + 1, left: rect.left, right: rect.right, cards};
  }, panel);
  assert.equal(metrics.documentOverflow, false, `${width}px 页面横向溢出`);
  assert.ok(metrics.left >= -1 && metrics.right <= width + 1, `${width}px 统计面板超出视口`);
  for (const card of metrics.cards) {
    assert.equal(card.overflow, false, `${width}px ${card.className} 内部横向溢出`);
    assert.ok(card.left >= metrics.left - 1 && card.right <= metrics.right + 1, `${width}px ${card.className} 超出面板`);
  }
  return {width, height, cards: metrics.cards.length};
}

// 免费链会请求公共接口，浏览器专项不联网；线路汇总按仓库结构直接写入本次临时 profile。
async function seedRouteRollups(page, routes) {
    await page.evaluate(async items => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('FluentReadTranslationStats');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction('routes', 'readwrite');
            const store = transaction.objectStore('routes');
            for (const item of items) store.put(item);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
    }, routes);
}

function routeRollupFixtures() {
    const bucketStart = new Date();
    bucketStart.setMinutes(0, 0, 0);
    const outcomes = (success, error) => ({success, error, timeout: 0, cancelled: 0});
    const histogram = index => Array.from({length: 12}, (_, position) => (position === index ? 1 : 0));
    return [
      {bucketStart: bucketStart.getTime(), serviceId: 'freeTranslation', route: 'microsoft', schemaVersion: 1,
        attemptCount: 6, outcomes: outcomes(5, 1), chars: 300, maxChars: 80,
        latencyCount: 5, latencyDurationMs: 1_500, latencyMaxDurationMs: 600, durationHistogram: histogram(2)},
      {bucketStart: bucketStart.getTime(), serviceId: 'freeTranslation', route: 'google', schemaVersion: 1,
        attemptCount: 3, outcomes: outcomes(3, 0), chars: 90, maxChars: 40,
        latencyCount: 3, latencyDurationMs: 2_400, latencyMaxDurationMs: 1_100, durationHistogram: histogram(4)},
      {bucketStart: bucketStart.getTime(), serviceId: 'freeTranslation', route: 'deeplx', schemaVersion: 1,
        attemptCount: 2, outcomes: outcomes(0, 2), chars: 40, maxChars: 20,
        latencyCount: 0, latencyDurationMs: 0, latencyMaxDurationMs: 0, durationHistogram: histogram(-1)},
    ];
}

async function readStoredStats(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('FluentReadTranslationStats');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const readAll = name => new Promise((resolve, reject) => {
        const request = database.transaction(name, 'readonly').objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {requests: await readAll('requests'), rollups: await readAll('rollups'), routes: await readAll('routes')};
    } finally {
      database.close();
    }
  });
}

async function main() {
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-translation-stats-profile-'));
  const report = {ok: false, suite: 'translation-stats', artifactType: 'production', extensionDir, artifactsDir,
    browser: 'isolated Microsoft Edge', manifest: {version: manifest.version, optionsPath},
    launchMode: null, focusPolicy: null, windowPlacement: null, assertions: {}, responsive: [], focusChecks: [],
    fixtureRequests: 0, consoleErrors: [], screenshots: []};
  const fixture = await startFixture();
  let launched;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath, headless: false, background: true,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
      viewport: {width: 1440, height: 1000}, timeout});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const {context} = launched;
    const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', {timeout});
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await newPageWithoutForeground(context, timeout);
    page.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});

    await page.goto(`${extensionOrigin}/${optionsPath}#settings-general`, {waitUntil: 'domcontentloaded', timeout});
    await page.setViewportSize({width: 1440, height: 1000});
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const config = await readConfig(page).catch(() => null);
      if (config?.service) break;
      await wait(50);
    }
    await patchConfig(page, {
      uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, service: 'deeplx', from: 'en', to: 'zh-Hans',
      useCache: true, enableAIContext: false, glossaryEnabled: false, translationMaxRetries: 0,
      deeplx: `${fixture.url}/deeplx`,
      customOpenAIProviders: [{id: AI_SERVICE, name: 'Stats fixture', endpoint: `${fixture.url}/v1/chat/completions`, models: ['stats-model']}],
      token: {[AI_SERVICE]: 'synthetic-local-fixture-not-a-secret'}, model: {[AI_SERVICE]: 'stats-model'},
      user_role: {[AI_SERVICE]: 'SOURCE_BEGIN{{origin}}SOURCE_END'},
    }, `translation-stats-${Date.now()}`);

    await page.goto(`${extensionOrigin}/${optionsPath}#settings-translation-stats`, {waitUntil: 'domcontentloaded', timeout});
    await page.locator(`${panel} .stats-state-empty`).waitFor({state: 'visible', timeout});
    assert.match(await page.locator('[data-section="settings-translation-stats"]').first().textContent(), /翻译统计/u);
    report.focusChecks.push(await assertBackground(context, 'empty panel'));
    await capture(page, report, 'translation-stats-empty');
    report.assertions.emptyStateOnFreshProfile = true;

    // 真实翻译链路：机器翻译单条、缓存、限流失败、并发复用，以及 AI 单条、批量和部分缓存。
    const deeplx = await translate(page, [
      {origin: 'alpha fast', serviceOverride: 'deeplx'},
      {origin: 'bravo medium', serviceOverride: 'deeplx'},
      {origin: 'charlie slow', serviceOverride: 'deeplx'},
    ]);
    assert.deepEqual(deeplx, [{ok: true}, {ok: true}, {ok: true}]);
    assert.deepEqual(await translate(page, [{origin: 'alpha fast', serviceOverride: 'deeplx'}]), [{ok: true}]);
    const [limited] = await translate(page, [{origin: 'limit exceeded', serviceOverride: 'deeplx'}]);
    assert.equal(limited.error, 'rate-limit', `限流响应应分类为 rate-limit：${JSON.stringify(limited)}`);
    assert.deepEqual(await translate(page, [
      {origin: 'golf shared', serviceOverride: 'deeplx'},
      {origin: 'golf shared', serviceOverride: 'deeplx', delayMs: 120},
    ]), [{ok: true}, {ok: true}]);
    assert.deepEqual(await translate(page, [{origin: 'hotel ai', serviceOverride: AI_SERVICE}]), [{ok: true}]);
    assert.deepEqual(await translate(page, [{origin: ['india', 'juliet'], serviceOverride: AI_SERVICE}]), [{ok: true}]);
    assert.deepEqual(await translate(page, [{origin: ['india', 'kilo'], serviceOverride: AI_SERVICE}]), [{ok: true}]);
    report.fixtureRequests = fixture.requests.length;
    assert.equal(fixture.requests.filter(item => item.text === 'golf shared').length, 1, '并发相同请求只应发送一次');
    assert.equal(fixture.requests.filter(item => item.text === 'alpha fast').length, 1, '重复请求应命中缓存');

    await refreshPanel(page, 10);
    const cards = await page.locator(`${panel} .stats-summary .stats-card`).allTextContents();
    assert.match(cards[0], /成功率 90%/u);
    assert.match(cards[3], /25%/u, '复用率 =（1 缓存段 + 1 部分缓存段 + 1 复用段）÷ 12 段');
    const latency = durationMs(await page.locator(`${panel} .stats-summary .stats-card-value`).nth(2).textContent());
    assert.ok(latency >= 250 && latency < 2_000, `平均耗时应只含 7 次成功服务请求：${latency}`);
    assert.match(cards[2], /最长 1[.,]\d+\s*秒/u, '最长耗时来自 1.3 秒的慢请求');
    report.assertions.overview = {requests: 10, successRate: '90%', reuseRate: '25%', averageDurationMs: latency};

    const services = page.locator(`${panel} .stats-service-table tbody tr`);
    assert.equal(await services.count(), 2);
    assert.match(await services.nth(0).textContent(), /DeepLX/u, '默认按请求量降序');
    await page.locator(`${panel} .stats-service-table thead .stats-sort`).nth(2).click();
    assert.match(await services.nth(0).textContent(), /Stats fixture.*stats-model/u, '平均耗时升序时 AI 夹具更快');
    assert.equal(await page.locator(`${panel} .stats-service-table thead th`).nth(3).getAttribute('aria-sort'), 'ascending');
    const failures = await page.locator(`${panel} .stats-failures`).textContent();
    assert.match(failures, /频率或额度受限\s*1/u);
    await page.locator(`${panel} .stats-trend`).scrollIntoViewIfNeeded();
    await capture(page, report, 'translation-stats-overview-1440');
    report.assertions.servicePerformanceSort = true;

    let rows = await logRows(page, 10);
    assert.equal(rows.filter(row => row.source.includes('is-cache')).length, 1);
    assert.equal(rows.filter(row => row.source.includes('is-partial')).length, 1);
    assert.equal(rows.filter(row => row.source.includes('is-shared')).length, 1);
    await page.locator(`${panel} .stats-log .stats-toggle button`).nth(1).click();
    rows = await pollRows(page, items => items.length === 10 && durationMs(items[0].duration) >= 1_250, '最慢排序首行应为 1.3 秒慢请求');
    assert.match(rows[0].text, /DeepLX/u);
    assert.ok(rows.every((row, index) => index === 0 || durationMs(row.duration) <= durationMs(rows[index - 1].duration) + 1), '记录应按耗时降序');
    await selectOption(page, '状态', '失败');
    rows = await logRows(page, 1);
    assert.match(rows[0].text, /频率或额度受限 · HTTP 429/u);
    await selectOption(page, '状态', '全部状态');
    await selectOption(page, '来源', '部分缓存');
    rows = await logRows(page, 1);
    assert.match(rows[0].text, /Stats fixture.*2 段/u);
    await page.locator(`${panel} .stats-log`).scrollIntoViewIfNeeded();
    await capture(page, report, 'translation-stats-request-log');
    await selectOption(page, '来源', '全部来源');
    await logRows(page, 10);
    report.assertions.requestLogFiltersAndSlowestSort = true;

    await services.filter({hasText: 'Stats fixture'}).click();
    await refreshPanel(page, 3);
    await page.locator(`${panel} input[aria-label="模型"]`).waitFor({state: 'attached', timeout});
    await page.locator(`${panel} .stats-range button`).first().click();
    await refreshPanel(page, 3);
    assert.ok(await page.locator(`${panel} .stats-trend-bar`).count() >= 23, '今日范围按小时绘制');
    for (const index of [1, 2]) {
      await page.locator(`${panel} .stats-trend .stats-toggle button`).nth(index).click();
      assert.equal(await page.locator(`${panel} .stats-trend .stats-toggle button`).nth(index).getAttribute('aria-pressed'), 'true');
    }
    await page.locator(`${panel} .stats-meta .stats-link`).click();
    await refreshPanel(page, 10);
    report.assertions.serviceFilterRangeAndTrendMetrics = true;

    await seedRouteRollups(page, routeRollupFixtures());
    await refreshPanel(page, 10);
    const routeRows = page.locator(`${panel} .stats-route-table tbody tr`);
    await routeRows.first().waitFor({state: 'visible', timeout});
    assert.equal(await routeRows.count(), 3, '免费线路表按线路列出尝试');
    assert.match(await routeRows.nth(0).textContent(), /微软翻译/u, '默认按尝试次数降序');
    assert.match(await routeRows.nth(0).textContent(), /83\.3%/u, '成功率按尝试计算');
    assert.match(await routeRows.nth(2).textContent(), /DeepLX/u);
    await page.locator(`${panel} .stats-route-table thead .stats-sort`).nth(2).click();
    assert.match(await routeRows.nth(0).textContent(), /微软翻译/u, '平均耗时升序时微软最快');
    assert.match(await routeRows.nth(2).textContent(), /DeepLX/u, '没有成功尝试的线路排在最后');
    assert.equal(await page.locator(`${panel} .stats-route-table thead th`).nth(3).getAttribute('aria-sort'), 'ascending');
    await page.locator(`${panel} .stats-routes`).scrollIntoViewIfNeeded();
    await capture(page, report, 'translation-stats-free-routes');
    report.assertions.freeRoutePerformance = true;

    const stored = await readStoredStats(page);
    assert.equal(stored.requests.length, 10);
    const serialized = JSON.stringify(stored);
    for (const word of FIXTURE_WORDS) assert.ok(!serialized.includes(word), `统计库不应包含翻译文本：${word}`);
    report.assertions.storedStatsContainOnlyNumbersAndIdentifiers = true;

    for (const [width, height] of [[1440, 1000], [1024, 900], [820, 900], [390, 844]]) {
      report.responsive.push(await measureLayout(page, width, height));
      await capture(page, report, `translation-stats-${width}`);
    }
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    report.responsive.push({...await measureLayout(page, 1440, 1000), dark: true});
    await capture(page, report, 'translation-stats-dark-1440');
    report.responsive.push({...await measureLayout(page, 390, 844), dark: true});
    await capture(page, report, 'translation-stats-dark-390');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await patchConfig(page, {uiLanguage: 'en-US'}, `translation-stats-language-${Date.now()}`);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('Service performance'), panel, {timeout});
    const englishText = await page.locator(panel).innerText();
    assert.ok(!/[\u3400-\u9fff]/u.test(englishText), `英文界面仍含中文：${englishText.match(/.{0,20}[\u3400-\u9fff].{0,20}/u)?.[0]}`);
    report.responsive.push({...await measureLayout(page, 820, 900), language: 'en-US'});
    await capture(page, report, 'translation-stats-en-820');
    await patchConfig(page, {uiLanguage: 'zh-CN'}, `translation-stats-language-back-${Date.now()}`);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('服务表现'), panel, {timeout});
    await page.setViewportSize({width: 1440, height: 1000});
    report.assertions.englishUiHasNoChineseCopy = true;

    await page.locator(`${panel} .stats-button-quiet`).click();
    const dialog = page.locator('.stats-dialog');
    await dialog.waitFor({state: 'visible', timeout});
    await capture(page, report, 'translation-stats-reset-dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden', timeout});
    await page.locator(`${panel} .stats-button-quiet`).click();
    await dialog.locator('.stats-button-danger').click();
    await page.locator(`${panel} .stats-state-empty`).waitFor({state: 'visible', timeout});
    assert.match(await page.locator(`${panel} .stats-notice`).textContent(), /翻译统计已清除/u);
    const cleared = await readStoredStats(page);
    assert.deepEqual([cleared.requests.length, cleared.rollups.length, cleared.routes.length], [0, 0, 0]);
    report.assertions.resetClearsBothStores = true;

    report.focusChecks.push(await assertBackground(context, 'after reset'));
    assert.deepEqual(report.consoleErrors, []);
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await launched?.close().catch(() => {});
    await fixture.close();
    fs.rmSync(profileDir, {recursive: true, force: true});
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
