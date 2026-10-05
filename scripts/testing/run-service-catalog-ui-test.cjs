'use strict';

/**
 * @file scripts/testing/run-service-catalog-ui-test.cjs
 * 文件职责：在第二屏后台隔离 Edge 中验证翻译服务完整目录的分类层级、服务顺序与免费翻译候选配置。
 * 主要内容：加载生产扩展，检查直接展示的完整目录、机器翻译、云服务厂商、模型服务商和聚合平台的目录顺序与计数，
 * 覆盖跨分类搜索、查看服务不改默认服务、窄屏无横向溢出，以及免费翻译的自动均衡/优先顺序、DeepLX 默认停用、启停、排序和重载持久化。
 * 模块边界：星标、自定义服务分类、主题与多语言归 run-service-library-ui-test.cjs；本脚本只操作本次创建的临时 profile，
 * 仅修改其中的免费候选配置，默认不请求任何翻译服务，只有显式 --live true 时才调用匿名测试翻译。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(argument('playwright-root', ''));
const focusSafeHelper = path.resolve(argument('focus-safe-helper', ''));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-service-catalog-ui'));
const browserPath = argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const timeout = Number(argument('timeout', '30000'));

const expectedFilters = ['全部分类', '机器翻译', '云服务厂商', '模型服务商', '聚合平台与接口'];
const expectedSections = ['machine-services', 'cloud-services', 'ai-providers', 'ai-platforms'];
const expectedMachineServices = [
  'freeTranslation', 'myMemory', 'microsoft', 'google', 'deepL', 'deeplx', 'xiaoniu', 'youdao', 'localTranslation',
];
// Chrome 内置 AI 翻译只在浏览器提供 Translator API 时出现，位置固定在有道翻译与本地模型之间。
const expectedMachineServicesWithChromeTranslator = [
  ...expectedMachineServices.slice(0, -1), 'chromeTranslator', 'localTranslation',
];
const expectedCloudServices = [
  'tencent', 'googleCloudTranslation', 'azureTranslator', 'aliyunTranslation', 'baiduTranslation', 'volcTranslation',
];
const expectedProviderServices = [
  'deepseek', 'tongyi', 'doubao', 'moonshot', 'zhipu', 'huanYuan',
  'huanYuanTranslation', 'yiyan', 'minimax', 'mimo', 'jieyue', 'openai',
  'gemini', 'claude', 'grok',
];
const expectedPlatformServices = [
  'siliconCloud', 'newapi', 'infini', 'openrouter', 'groq', 'azureOpenai',
  'mistral', 'cohere', 'cerebras', 'togetherai', 'fireworks', 'deepinfra', 'perplexity', 'ollama',
];
const expectedFreeCandidates = [
  'microsoft', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'deeplx', 'myMemory',
  'sogouFree', 'reversoFree', 'lingvaFree', 'apertiumFree',
];
const defaultDisabledFreeCandidates = ['deeplx'];
const expectedEnabledFreeCandidates = expectedFreeCandidates.filter(id => !defaultDisabledFreeCandidates.includes(id));
// 免密钥网页接口只能作为免费翻译内部候选，不能泄漏成目录中的独立服务。
const candidateOnlyServices = expectedFreeCandidates.filter(id => !['microsoft', 'google', 'deeplx', 'myMemory'].includes(id));

if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`扩展产物不存在：${extensionDir}`);
if (!fs.existsSync(focusSafeHelper)) throw new Error(`防抢焦点 helper 不存在：${focusSafeHelper}`);
fs.mkdirSync(artifactsDir, {recursive: true});

const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {
  launchFocusSafePersistentContext,
  newPageWithoutForeground,
} = require(focusSafeHelper);

async function screenshot(page, file, report) {
  const target = path.join(artifactsDir, file);
  await page.screenshot({path: target, fullPage: false});
  report.screenshots.push(target);
}

function assertSameOrder(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}分类或顺序异常：${JSON.stringify(actual)}`);
  }
}

async function readStoredConfig(page) {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!response || response.success !== true) throw new Error(`后台配置读取失败：${response?.error || '无响应'}`);
    return typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
  });
}

async function waitForStoredFreeTranslation(page, expected) {
  const deadline = Date.now() + timeout;
  let stored;
  while (Date.now() < deadline) {
    stored = await readStoredConfig(page);
    if (stored.freeTranslationMode === expected.mode
      && JSON.stringify(stored.freeTranslationOrder) === JSON.stringify(expected.order)) {
      return {mode: stored.freeTranslationMode, order: stored.freeTranslationOrder};
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`免费候选没有持久化：${JSON.stringify({expected, mode: stored?.freeTranslationMode, order: stored?.freeTranslationOrder})}`);
}

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-service-catalog-profile-'));
  const consoleErrors = [];
  const report = {
    ok: false,
    extensionDir,
    artifactsDir,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    manifest: {},
    directory: {},
    editing: {},
    responsive: [],
    freeCandidates: {},
    consoleErrors,
    screenshots: [],
  };
  let launched;

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    report.manifest = {
      popup: manifest.action?.default_popup || manifest.browser_action?.default_popup || '',
      options: manifest.options_ui?.page || manifest.options_page || '',
    };
    if (!report.manifest.popup || !report.manifest.options) throw new Error('扩展清单缺少 popup 或 options 入口');

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
    if (report.windowPlacement?.browserFrontmost !== false) throw new Error('隔离 Edge 抢占了前台焦点');

    const {context} = launched;
    let workers = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension://'));
    if (workers.length === 0) workers = [await context.waitForEvent('serviceworker', {timeout})];
    const extensionOrigin = `chrome-extension://${new URL(workers[0].url()).host}`;
    const page = await newPageWithoutForeground(context, timeout);
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });

    await page.goto(`${extensionOrigin}/options.html#settings-services`, {waitUntil: 'domcontentloaded', timeout});
    await page.setViewportSize({width: 1440, height: 1000});
    const catalog = page.locator('.service-catalog');
    await catalog.waitFor({state: 'visible', timeout});
    const directory = catalog.locator('.service-rail');
    const rail = directory;
    const views = await catalog.locator('[data-service-view]').count();
    if (views !== 0) throw new Error('完整目录不应包含视图切换入口');
    const defaultService = await catalog.getAttribute('data-default-service');
    if (defaultService !== 'freeTranslation') throw new Error('初始默认服务异常');
    const sections = await directory.locator('[data-service-section]').evaluateAll(nodes => nodes.map(node => ({
      id: node.dataset.serviceSection,
      heading: node.querySelector('h4')?.childNodes[0]?.textContent?.trim() || '',
      services: [...node.querySelectorAll('[data-service-value]')].map(item => item.dataset.serviceValue),
    })));
    assertSameOrder(sections.map(section => section.id), expectedSections, '顶层目录');
    assertSameOrder(sections.map(section => section.heading), expectedFilters.slice(1), '目录标题');
    const byId = Object.fromEntries(sections.map(section => [section.id, section]));
    const machineServices = byId['machine-services'].services;
    if (JSON.stringify(machineServices) !== JSON.stringify(expectedMachineServices)
      && JSON.stringify(machineServices) !== JSON.stringify(expectedMachineServicesWithChromeTranslator)) {
      throw new Error(`机器翻译分类或顺序异常：${JSON.stringify(machineServices)}`);
    }
    assertSameOrder(byId['cloud-services'].services, expectedCloudServices, '云服务厂商');
    assertSameOrder(byId['ai-providers'].services, expectedProviderServices, '模型服务商');
    assertSameOrder(byId['ai-platforms'].services, expectedPlatformServices, '聚合平台');
    const allServiceCount = sections.reduce((sum, section) => sum + section.services.length, 0);
    const allViewCount = Number(await catalog.locator('.service-count').textContent());
    if (allViewCount !== allServiceCount) throw new Error('完整服务计数不一致');
    const leakedServices = await directory.locator('[data-service-value]').evaluateAll(
      (items, forbidden) => items.map(item => item.dataset.serviceValue).filter(value => forbidden.includes(value)),
      [...candidateOnlyServices, 'custom'],
    );
    if (leakedServices.length) throw new Error(`免费候选或旧自定义入口泄漏到独立目录：${JSON.stringify(leakedServices)}`);
    if (await directory.locator('[data-service-section="custom"]').count()) {
      throw new Error('没有自定义服务时目录仍显示自定义分类');
    }
    const iconFailures = await directory.locator('[data-service-value]').evaluateAll(items => items
      .filter(item => !item.querySelector('svg') || item.querySelector('svg text, img, image, [data-service-icon-fallback]'))
      .map(item => item.dataset.serviceValue));
    if (iconFailures.length) throw new Error(`服务目录存在未渲染的本地内联图标：${JSON.stringify(iconFailures)}`);
    report.directory = {
      views,
      sections: sections.map(({id, services}) => ({id, services})),
      allServiceCount,
      chromeTranslatorListed: machineServices.includes('chromeTranslator'),
      candidateOnlyServicesHidden: candidateOnlyServices,
    };
    await screenshot(page, 'service-catalog-all.png', report);

    // 搜索直接过滤完整目录，清空后恢复所有分类。
    const serviceSearch = catalog.getByRole('searchbox', {name: '搜索所有翻译服务'});
    await serviceSearch.fill('微软翻译');
    const microsoftResult = await directory.locator('[data-service-value]').evaluateAll(items => items.map(item => item.dataset.serviceValue));
    assertSameOrder(microsoftResult, ['microsoft'], '机器翻译搜索');
    await serviceSearch.fill('New API');
    const newApiResult = await directory.locator('[data-service-value]').evaluateAll(items => items.map(item => item.dataset.serviceValue));
    assertSameOrder(newApiResult, ['newapi'], '聚合平台搜索');
    await serviceSearch.fill('nonexistent-service-97531');
    await directory.getByRole('status').waitFor({state: 'visible', timeout});
    await serviceSearch.fill('');
    report.directory.filterAndSearch = { microsoftResult, newApiResult, emptyState: true};

    // 从目录查看服务只切换编辑目标，默认服务、默认标记和个人列表中的默认分组保持不变。
    await directory.locator('[data-service-value="deepseek"]').click();
    await page.waitForFunction(() => document.querySelector('.service-catalog')?.getAttribute('data-editing-service') === 'deepseek', null, {timeout});
    if (await catalog.getAttribute('data-default-service') !== defaultService) throw new Error('查看服务误改默认服务');
    if (!await catalog.getByRole('button', {name: '设为默认', exact: true}).isVisible()) throw new Error('非默认服务缺少显式“设为默认”操作');
    if ((await readStoredConfig(page)).service !== defaultService) throw new Error('查看服务写入了 config.service');
    await screenshot(page, 'service-catalog-editing-deepseek.png', report);
    report.editing = {defaultService, editingService: 'deepseek', storedServiceUnchanged: true};

    for (const viewport of [
      {width: 820, height: 900},
      {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      for (const view of ['directory']) {
        await page.waitForTimeout(150);
        const metrics = await page.evaluate(() => ({
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          catalogWidth: Math.round(document.querySelector('.service-catalog')?.getBoundingClientRect().width || 0),
          viewportWidth: window.innerWidth,
          overflowingControls: [...document.querySelectorAll('.catalog-toolbar button, .catalog-search, .directory-filters button, .directory-grid, .service-rail')]
            .filter(node => node.getClientRects().length)
            .filter(node => node.getBoundingClientRect().right > innerWidth + 1 || node.getBoundingClientRect().left < 0).length,
        }));
        if (metrics.horizontalOverflow || metrics.catalogWidth > metrics.viewportWidth + 1 || metrics.overflowingControls) {
          throw new Error(`${viewport.width}px ${view} 服务目录横向溢出：${JSON.stringify(metrics)}`);
        }
        report.responsive.push({...viewport, view, ...metrics});
        await screenshot(page, `service-catalog-${viewport.width}-${view}.png`, report);
      }
    }

    // 免费翻译：候选按注册表展示，DeepLX 默认停用；改为优先顺序后可启停、排序并在重载后保持。
    await page.setViewportSize({width: 1440, height: 1000});
    const openFreeTranslation = async () => {
      await rail.locator('[data-service-value="freeTranslation"]').click();
      await page.locator('[data-free-translation-settings] [data-fallback-provider]').first().waitFor({state: 'visible', timeout});
    };
    await openFreeTranslation();
    const freeSettings = page.locator('[data-free-translation-settings]');
    const candidateRows = freeSettings.locator('[data-fallback-provider]');
    const readCandidates = () => candidateRows.evaluateAll(rows => rows.map(row => ({
      id: row.dataset.fallbackProvider,
      enabled: !row.classList.contains('is-disabled'),
    })));
    const initialCandidates = await readCandidates();
    assertSameOrder(initialCandidates.map(row => row.id), expectedFreeCandidates, '免费候选');
    assertSameOrder(initialCandidates.filter(row => row.enabled).map(row => row.id), expectedEnabledFreeCandidates, '默认启用免费候选');
    const enabledOptional = initialCandidates.filter(row => defaultDisabledFreeCandidates.includes(row.id) && row.enabled);
    if (enabledOptional.length) throw new Error(`可选候选默认启用：${JSON.stringify(enabledOptional)}`);
    const modeRadio = mode => freeSettings.locator(`input[name="free-translation-mode"][value="${mode}"]`);
    if (!await modeRadio('balanced').isChecked() || await freeSettings.getByRole('button', {name: /^上移 /u}).count()) {
      throw new Error('免费翻译默认不是自动均衡，或自动均衡仍显示排序按钮');
    }

    await freeSettings.locator('[data-fallback-provider="deeplx"] .el-switch').click();
    await modeRadio('sequential').check();
    await freeSettings.getByRole('button', {name: '上移 DeepLX', exact: true}).click();
    await freeSettings.locator('[data-fallback-provider="yandexFree"] .el-switch').click();
    const expectedOrder = ['microsoft', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'myMemory', 'sogouFree', 'reversoFree', 'lingvaFree', 'deeplx', 'apertiumFree'];
    const sequentialCandidates = await readCandidates();
    assertSameOrder(sequentialCandidates.filter(row => row.enabled).map(row => row.id), expectedOrder, '优先顺序');
    assertSameOrder(sequentialCandidates.map(row => row.id).slice(0, expectedOrder.length), expectedOrder, '优先顺序中启用候选置顶');
    const positions = await freeSettings.locator('.provider-position').allTextContents();
    if (positions[expectedOrder.indexOf('deeplx')]?.trim() !== String(expectedOrder.indexOf('deeplx') + 1)) {
      throw new Error(`优先顺序序号异常：${JSON.stringify(positions)}`);
    }
    if (!await freeSettings.getByRole('button', {name: '上移 微软翻译', exact: true}).isDisabled()) throw new Error('首个候选仍可上移');
    await freeSettings.locator('[data-fallback-provider="sogouFree"]').scrollIntoViewIfNeeded();
    await screenshot(page, 'free-candidates-sequential.png', report);
    const stored = await waitForStoredFreeTranslation(page, {mode: 'sequential', order: expectedOrder});

    await page.reload({waitUntil: 'domcontentloaded'});
    await catalog.waitFor({state: 'visible', timeout});
    await openFreeTranslation();
    const reloadedCandidates = await readCandidates();
    assertSameOrder(reloadedCandidates.filter(row => row.enabled).map(row => row.id), expectedOrder, '免费候选持久化');
    if (!await modeRadio('sequential').isChecked()) throw new Error('重载后免费翻译模式没有保持优先顺序');
    report.freeCandidates = {
      candidateIds: initialCandidates.map(row => row.id),
      defaultEnabled: expectedEnabledFreeCandidates,
      defaultDisabled: defaultDisabledFreeCandidates,
      stored,
      reloaded: reloadedCandidates.filter(row => row.enabled).map(row => row.id),
      standaloneEntries: 0,
    };
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(150);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('免费候选在窄屏横向溢出');
    await freeSettings.locator('[data-fallback-provider="sogouFree"]').scrollIntoViewIfNeeded();
    await screenshot(page, 'free-candidates-390.png', report);

    if (argument('live', 'false') === 'true') {
      report.liveConnections = [];
      await page.setViewportSize({width: 1440, height: 1000});
      for (const id of ['transmart', 'yandexFree', 'volcengineFree']) {
        const selected = freeSettings.locator(`[data-fallback-provider="${id}"]`);
        if ((await selected.getAttribute('class') || '').includes('is-disabled')) await selected.locator('.el-switch').click();
        for (const other of expectedFreeCandidates.filter(value => value !== id)) {
          const row = freeSettings.locator(`[data-fallback-provider="${other}"]`);
          if (!(await row.getAttribute('class') || '').includes('is-disabled')) await row.locator('.el-switch').click();
        }
        await page.locator('[data-connection-test-button]').first().click();
        await page.locator('[data-connection-test-status]:not(.is-testing)').waitFor({state: 'visible', timeout});
        const result = page.locator('[data-connection-test-status]');
        const success = (await result.getAttribute('class') || '').includes('is-success');
        report.liveConnections.push({id, success, message: await result.innerText()});
        if (!success) throw new Error(`真实连接失败：${id}: ${await result.innerText()}`);
      }
    }

    if (consoleErrors.length) throw new Error(`浏览器控制台存在错误：${consoleErrors.join(' | ')}`);
    report.ok = true;
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
