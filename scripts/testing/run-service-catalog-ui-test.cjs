'use strict';

/**
 * @file scripts/testing/run-service-catalog-ui-test.cjs
 * 文件职责：在不抢焦点的隔离 Edge 中验证翻译服务目录的二级分类、顺序、折叠、搜索与响应式布局。
 * 主要内容：加载生产扩展，检查动态自定义服务入口、模型服务商和聚合平台清单，覆盖机器翻译手动折叠、搜索自动展开、编辑状态与窄屏无横向溢出。
 * 模块边界：脚本只操作本次创建的临时浏览器 profile，不访问用户日常浏览器，也仅在临时 profile 中验证实例地址持久化，不调用翻译服务。
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

const expectedProviderServices = [
  'deepseek', 'tongyi', 'doubao', 'moonshot', 'zhipu', 'huanYuan',
  'huanYuanTranslation', 'yiyan', 'minimax', 'mimo', 'jieyue', 'openai',
  'gemini', 'claude', 'grok',
];
const expectedPlatformServices = [
  'siliconCloud', 'newapi', 'infini', 'openrouter', 'groq', 'azureOpenai',
];
const expectedMachineServices = [
  'freeTranslation', 'apertium', 'libreTranslate', 'myMemory', 'microsoft', 'google', 'deepL', 'deeplx', 'xiaoniu', 'youdao', 'tencent',
];

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

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-service-catalog-profile-'));
  const consoleErrors = [];
  const report = {
    extensionDir,
    artifactsDir,
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    manifest: {},
    serviceGroups: {},
    collapse: {},
    responsive: [],
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

    const topLevelGroups = (await catalog.locator('.group-heading strong').allTextContents()).map(value => value.trim());
    assertSameOrder(topLevelGroups, ['我的服务', '机器翻译', 'AI翻译'], '顶层服务');
    const subgroupLabels = (await catalog.locator('.subgroup-heading strong').allTextContents()).map(value => value.trim());
    assertSameOrder(subgroupLabels, ['模型服务商', '聚合平台与接口'], 'AI 二级');

    const providerServices = await catalog
      .locator('[data-service-subgroup="ai-providers"] .service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    const platformServices = await catalog
      .locator('[data-service-subgroup="ai-platforms"] .service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    assertSameOrder(providerServices, expectedProviderServices, '模型服务商');
    assertSameOrder(platformServices, expectedPlatformServices, '聚合平台');
    const customGroup = catalog.locator('.custom-service-group');
    const customCount = (await customGroup.getByTestId('custom-service-count').textContent())?.trim();
    if (customCount !== '0 / 20'
      || await customGroup.getByTestId('custom-service-add').isDisabled()
      || !await customGroup.getByText('还没有自定义服务', {exact: true}).isVisible()) {
      throw new Error(`空自定义服务入口异常：${customCount}`);
    }
    const machineGroup = catalog.locator('[data-service-section="machine"]');
    const serviceItems = catalog.locator('.service-item');
    const machineServices = await machineGroup.locator('.service-item')
      .evaluateAll(items => items.map(item => item.getAttribute('data-service-value')));
    const chromeMachineServices = [...expectedMachineServices, 'chromeTranslator'];
    if (JSON.stringify(machineServices) !== JSON.stringify(expectedMachineServices)
      && JSON.stringify(machineServices) !== JSON.stringify(chromeMachineServices)) {
      throw new Error(`机器翻译分类或顺序异常：${JSON.stringify(machineServices)}`);
    }
    if (await serviceItems.count() !== machineServices.length + expectedProviderServices.length + expectedPlatformServices.length) {
      throw new Error(`服务项数量异常：机器翻译 ${machineServices.length}，全部 ${await serviceItems.count()}`);
    }
    report.serviceGroups = {
      topLevelGroups,
      subgroupLabels,
      machineServices,
      providerServices,
      platformServices,
      customServices: {count: 0, limit: 20, addEnabled: true},
    };
    if (await serviceItems.locator('.service-brand-icon svg').count() !== await serviceItems.count()) {
      throw new Error('服务列表存在未渲染的本地图标');
    }

    const defaultService = await catalog.getAttribute('data-default-service');
    const machineToggle = machineGroup.locator('[data-service-section-toggle="machine"]');
    if (await machineToggle.getAttribute('aria-expanded') !== 'true') {
      throw new Error(`默认机器翻译服务没有自动展开：${defaultService}`);
    }
    const defaultItem = catalog.locator(`.service-item[data-service-value="${defaultService}"]`);
    if (await defaultItem.count() !== 1 || !await defaultItem.isVisible()) throw new Error('当前默认服务没有保持可见');

    await machineToggle.click();
    if (await machineToggle.getAttribute('aria-expanded') !== 'false'
      || await machineGroup.locator('.service-item').first().isVisible()) {
      throw new Error('机器翻译分组无法收起');
    }
    await screenshot(page, 'service-catalog-machine-collapsed.png', report);

    const serviceSearch = catalog.getByPlaceholder('搜索翻译服务');
    await serviceSearch.fill('微软翻译');
    await machineGroup.locator('.service-item[data-service-value="microsoft"]').waitFor({state: 'visible', timeout});
    if (await machineToggle.getAttribute('aria-expanded') !== 'true') throw new Error('搜索机器翻译时没有自动展开分组');
    if (!await machineToggle.isDisabled()) throw new Error('搜索期间机器翻译折叠按钮仍可操作');
    await serviceSearch.fill('');
    await machineGroup.locator('.service-item').first().waitFor({state: 'hidden', timeout});
    if (await machineToggle.getAttribute('aria-expanded') !== 'false') throw new Error('清空搜索后没有恢复手动折叠状态');
    if (await machineToggle.isDisabled()) throw new Error('清空搜索后机器翻译折叠按钮没有恢复可用');

    const deepSeekItem = catalog.locator('.service-item[data-service-value="deepseek"]');
    await deepSeekItem.click();
    await page.waitForFunction(() => document.querySelector('.service-catalog')?.getAttribute('data-editing-service') === 'deepseek', null, {timeout});
    if (await catalog.getAttribute('data-default-service') !== defaultService) throw new Error('切换编辑服务时误改默认服务');
    if (await machineToggle.getAttribute('aria-expanded') !== 'false') throw new Error('选择 AI 服务后覆盖了用户的机器翻译折叠状态');
    if (!await catalog.getByText('正在配置', {exact: true}).isVisible()) throw new Error('非默认服务没有显示正在配置状态');
    await screenshot(page, 'service-catalog-providers.png', report);

    const platformHeading = catalog.locator('[data-service-subgroup="ai-platforms"] .subgroup-heading');
    await platformHeading.scrollIntoViewIfNeeded();
    await screenshot(page, 'service-catalog-platforms.png', report);

    await serviceSearch.fill('New API');
    const visibleSearchItems = catalog.locator('.service-item:visible');
    if (await visibleSearchItems.count() !== 1
      || await visibleSearchItems.first().getAttribute('data-service-value') !== 'newapi') {
      throw new Error('聚合平台搜索结果不唯一或不正确');
    }
    await serviceSearch.fill('');

    report.collapse = {
      defaultService,
      currentMachineServiceAutoExpanded: true,
      manualCollapse: true,
      searchAutoExpanded: true,
      clearSearchRestoredCollapse: true,
      aiSelectionPreservedCollapse: true,
    };

    await serviceSearch.fill('Apertium');
    await catalog.locator('[data-service-value="apertium"]').click();
    const apertiumConfiguration = page.locator('[data-service-configuration-service="apertium"]');
    await apertiumConfiguration.waitFor({state: 'visible', timeout});
    if (!await apertiumConfiguration.getByText('Apertium 支持部分欧洲语言对，不支持中日韩。短文本请手动选择来源语言；不支持的语言对会提示切换服务。', {exact: true}).isVisible()
      || await apertiumConfiguration.locator('input[type="password"]').count()) {
      throw new Error('Apertium 语言限制说明或免密钥配置异常');
    }
    await screenshot(page, 'apertium-settings.png', report);
    await serviceSearch.fill('LibreTranslate');
    await catalog.locator('[data-service-value="libreTranslate"]').click();
    const instanceInput = page.getByRole('textbox', {name: 'LibreTranslate 实例地址', exact: true});
    await instanceInput.fill('http://localhost:5000/translate');
    await instanceInput.blur();
    await page.waitForTimeout(600);
    await page.reload({waitUntil: 'domcontentloaded'});
    await catalog.waitFor({state: 'visible', timeout});
    await serviceSearch.fill('LibreTranslate');
    await catalog.locator('[data-service-value="libreTranslate"]').click();
    if (await instanceInput.inputValue() !== 'http://localhost:5000/translate') {
      throw new Error('LibreTranslate 实例地址重开后未保留');
    }
    const libreConfiguration = page.locator('[data-service-configuration-service="libreTranslate"]');
    if (await libreConfiguration.locator('input[type="password"]').count() !== 1) {
      throw new Error('LibreTranslate 缺少可选密钥输入');
    }
    report.openTranslationServices = {apertiumKeyless: true, languageLimitVisible: true, libreEndpointPersisted: true, libreOptionalKeyVisible: true};
    await screenshot(page, 'libretranslate-settings.png', report);

    for (const viewport of [
      {width: 820, height: 900},
      {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        catalogWidth: Math.round(document.querySelector('.service-catalog')?.getBoundingClientRect().width || 0),
        viewportWidth: window.innerWidth,
        serviceRailOverflow: (() => {
          const rail = document.querySelector('.service-rail');
          return rail ? rail.scrollHeight > rail.clientHeight : false;
        })(),
      }));
      if (metrics.horizontalOverflow || metrics.catalogWidth > metrics.viewportWidth + 1) {
        throw new Error(`${viewport.width}px 服务目录横向溢出：${JSON.stringify(metrics)}`);
      }
      report.responsive.push({...viewport, ...metrics});
      await screenshot(page, `service-catalog-${viewport.width}.png`, report);
    }

    if (consoleErrors.length) throw new Error(`浏览器控制台存在错误：${consoleErrors.join(' | ')}`);
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
