'use strict';
// 生产扩展选择器回归：使用临时 profile、真实后台 Edge 和现有配置接口，不调用翻译服务。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arg = (key, fallback) => { const i = process.argv.indexOf('--' + key); return i < 0 ? fallback : process.argv[i + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const output = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-select-ui-production'));
const {chromium} = require(path.join(arg('playwright-root', ''), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', ''));
const report = {ok: false, extensionDir, caseCoverage: [], screenshots: [], consoleErrors: [], persistenceCases: [], responsive: []};
const check = (condition, message) => { if (!condition) throw new Error(message); report.caseCoverage.push(message); };
fs.mkdirSync(output, {recursive: true});
(async () => {
  let session, page;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-select-ui-'));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    report.manifest = {popup: manifest.action.default_popup, options: manifest.options_ui?.page || manifest.options_page};
    session = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'], viewport: {width: 1440, height: 1000}, timeout: 30000});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    check(session.windowPlacement.browserFrontmost === false, '后台 Edge 没有成为前台应用');
    const context = session.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const newPage = async () => {
      page = await newPageWithoutForeground(context, 20000);
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => report.consoleErrors.push(e.message));
      page.on('console', e => { if (e.type() === 'error') report.consoleErrors.push(e.text()); });
    };
    await newPage();
    const go = async (file, width = 1440, height = 1000) => {
      await page.setViewportSize({width, height});
      await page.goto(origin + '/' + file);
      await page.locator(file.startsWith('popup') ? '.popup-shell[data-config-ready="true"]' : file.startsWith('options') ? '.settings-app' : '.document-app').waitFor();
    };
    const read = () => page.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    });
    const patch = async values => {
      const result = await page.evaluate(async values => {
        const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const current = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: values, expected: Object.fromEntries(Object.keys(values).map(k => [k, current[k]])), clientId: 'select-ui-fixture', sequence: Date.now(), baseRevision: 0});
      }, values);
      if (!result.success) throw new Error('测试配置保存失败');
    };
    const root = input => input.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," fluentread-select ")][1]');
    const popup = () => page.locator('.el-popper.fluentread-select-popper:visible');
    const shot = async name => { await page.waitForTimeout(220); const file = path.join(output, name + '.png'); await page.screenshot({path: file}); report.screenshots.push(file); };
    const open = async (input, name) => {
      await input.scrollIntoViewIfNeeded();
      await input.press('Enter');
      await popup().waitFor();
      await page.waitForTimeout(220);
      if (name) await shot(name);
      return popup();
    };
    const close = async input => {
      // Element Plus 2.9.3 的第一次 Escape 清空查询，第二次关闭；保留该既有行为。
      if (await input.inputValue()) await input.press('Escape');
      await input.press('Escape');
      await popup().waitFor({state: 'hidden'});
    };
    const choose = async (input, query) => {
      await open(input); await input.fill(query);
      const option = popup().locator('.el-select-dropdown__item:visible:not(.is-disabled)').first();
      await option.waitFor(); await option.click(); await popup().waitFor({state: 'hidden'});
    };
    const nav = async id => { await page.locator(`nav [data-section="${id}"]`).click(); await page.waitForTimeout(150); };
    await go(report.manifest.options);
    await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, theme: 'light', interfaceSkin: 'default', service: 'freeTranslation', to: 'zh-CN', selectionTranslatorMode: 'bilingual', selectionTtsVoices: []});
    await page.reload(); await page.locator('.settings-app').waitFor();
    const service = page.getByRole('combobox', {name: '默认网页翻译服务', exact: true});
    const target = page.locator('[data-config-field="to"] input[role="combobox"]');
    const style = page.getByRole('combobox', {name: '译文样式', exact: true});
    await open(service, 'options-service-menu');
    check(await root(service).locator('input').count() === 1 && (await root(service).innerText()).includes('搜索翻译服务'), '服务展开后显示明确搜索提示，并且只有一个输入框');
    check(await root(service).locator('.fluentread-select-search-icon').count() === 1, '展开时服务图标变成搜索图标');
    check(await popup().locator('.el-select-group__title').count() === 2, '服务菜单包含机器翻译和 AI 翻译两个真实分组');
    const width = await popup().evaluate(el => el.getBoundingClientRect().width);
    const inputWidth = await root(service).evaluate(el => el.getBoundingClientRect().width);
    check(Math.abs(width - inputWidth) <= 3, '服务菜单与选择框宽度对齐');
    check(await service.evaluate(el => getComputedStyle(el).outlineStyle === 'none'), '筛选输入不产生重复焦点框');
    await service.fill('__nothing_matches__');
    await popup().locator('.el-select-dropdown__empty').waitFor();
    check((await popup().innerText()).includes('没有匹配的选项'), '搜索无结果有中文反馈'); await shot('options-service-empty');
    await service.press('Escape');
    check(await service.inputValue() === '' && await service.getAttribute('aria-expanded') === 'true', 'Escape 先清空查询且保留菜单');
    await close(service);
    await open(service); await service.fill('DeepSeek');
    await popup().locator('.el-select-dropdown__item:visible').first().waitFor();
    check(await popup().locator('.el-select-dropdown__item:visible').count() === 1, '搜索 DeepSeek 只显示匹配服务'); await shot('options-service-search');
    await service.press('ArrowDown'); await service.press('Enter'); await popup().waitFor({state: 'hidden'});
    check((await root(service).innerText()).includes('DeepSeek'), '方向键和 Enter 选择服务');
    await open(service); await page.locator('.topbar h1').click(); await popup().waitFor({state: 'hidden'});
    check(await service.getAttribute('aria-expanded') === 'false', '点击外部关闭菜单');
    await choose(target, 'French');
    const expectedTarget = await root(target).locator('.el-select__placeholder').innerText();
    await open(style, 'options-style-menu'); await close(style);
    // 立即关闭选项页，验证已有后台持久化路径，不只检查当前 DOM。
    await page.close(); await newPage(); await go(report.manifest.options);
    check((await read()).service === 'deepseek', '服务选择关闭页面后仍保存');
    check((await page.locator('[data-config-field="to"] .el-select__placeholder').innerText()) === expectedTarget, '语言选择关闭页面后仍保存');
    report.persistenceCases.push({close: 'page.close', reopenedService: (await read()).service, reopenedLanguage: (await read()).to, visibleLanguage: expectedTarget});
    await shot('options-reopened');
    const uiLanguage = page.locator('[data-testid="ui-language-select"] input');
    await open(uiLanguage, 'interface-language-menu');
    check(await popup().evaluate(el => el.classList.contains('ui-language-select-popper')), '专属界面语言菜单类名与共享类名同时保留'); await close(uiLanguage);
    // 有意保留当前默认服务，逐主题验证相同菜单。
    for (const [skin, theme, screenWidth] of [['default','light',1440],['default','light',820],['default','light',390],['default','dark',1440],['sakura','dark',1440]]) {
      await patch({theme, interfaceSkin: skin}); await page.setViewportSize({width: screenWidth, height: 900});
      const input = page.getByRole('combobox', {name: '默认网页翻译服务', exact: true});
      await open(input, `service-${skin}-${theme}-${screenWidth}`);
      const m = await popup().evaluate(el => { const b = el.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight,background:getComputedStyle(el).backgroundColor}; });
      check(m.left >= 0 && m.right <= m.width + 1 && m.top >= 0 && m.bottom <= m.height + 1, `${skin}/${theme}/${screenWidth} 菜单完整位于视口`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${screenWidth} 设置页没有横向溢出`);
      check(await input.evaluate(el => getComputedStyle(el).outlineStyle === 'none'), `${skin}/${theme} 搜索输入没有重复焦点框`);
      report.responsive.push({skin, theme, ...m}); await close(input);
    }
    await patch({theme:'light',interfaceSkin:'default'}); await page.setViewportSize({width:1440,height:1000});
    await nav('settings-model-usage');
    const usage = page.getByRole('combobox', {name:'模型用量服务',exact:true});
    await open(usage, 'usage-service-menu'); check(await popup().evaluate(el => el.classList.contains('usage-select-popper')), '模型用量菜单保留专属类名');
    check(await popup().evaluate(el => el.getBoundingClientRect().width > 250), '没有服务记录时模型用量菜单仍保持可读宽度'); await close(usage);
    await nav('settings-harness');
    const model = page.getByRole('combobox', {name:'翻译卡片模型',exact:true});
    await open(model); await model.fill('fluentread-test-model'); await model.press('Enter'); await popup().waitFor({state:'hidden'});
    check((await root(model).innerText()).includes('fluentread-test-model'), 'allow-create 模型输入仍然可用');
    await nav('settings-services');
    await page.locator('.model-picker-trigger').first().click();
    await page.locator('.model-picker-popper.el-popper:visible').waitFor(); await shot('model-picker');
    const rows = await page.locator('.model-picker-popper:visible .model-picker-chip').evaluateAll(els => els.map(el => ({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
    check(rows.length > 0 && rows.every(row => row.height >= 38), '模型菜单使用易点击的整行选项'); await page.keyboard.press('Escape');
    await nav('settings-translation-center'); await page.locator('.translation-center-service-picker > button').click(); await page.locator('.service-picker-popover').waitFor(); await shot('translation-center-services');
    await page.locator('.service-picker-close').click();
    await go(report.manifest.popup, 390, 600);
    await page.locator('.service-field').click(); await page.locator('.service-picker-panel').waitFor(); await shot('popup-service-menu');
    await page.getByRole('searchbox',{name:'搜索翻译服务或模型'}).fill('DeepSeek');
    check(await page.locator('.service-search input').count() === 1, 'Popup 服务菜单保留唯一搜索框'); await page.keyboard.press('Escape'); await page.locator('.service-picker-panel').waitFor({state:'hidden'});
    const popupTarget = page.getByRole('combobox',{name:'目标语言',exact:true});
    await open(popupTarget,'popup-target-language'); await popupTarget.fill('French'); await close(popupTarget);
    const enabled = page.getByRole('switch').first(); await enabled.click();
    check(await popupTarget.isDisabled(), '暂停插件后语言选择框禁用'); await enabled.click();
    // 语音回退设置位于完整设置页；最新 Popup 只保留快捷设置入口。
    await page.goto(origin + '/' + report.manifest.options + '#settings-translation');
    await page.locator('.settings-app').waitFor();
    const voices = page.getByRole('combobox',{name:'划词翻译语音回退顺序',exact:true});
    await open(voices); const voiceItems = popup().locator('.el-select-dropdown__item:visible');
    await voiceItems.nth(0).click(); await voiceItems.nth(1).click();
    check((await read()).selectionTtsVoices.length === 2, '真实多选保存两个音色');
    await shot('selection-multiple-menu'); await close(voices);
    const tags = root(voices).locator('.el-tag__close'); await tags.first().click();
    await page.waitForTimeout(150);
    check((await read()).selectionTtsVoices.length === 1, '多选标签可以移除');
    report.multiSelect = {selected:2,remainingAfterRemoval:1};
    await go('document.html',1440,1000);
    await page.locator('input[type="file"]').setInputFiles({name:'select-ui.txt',mimeType:'text/plain',buffer:Buffer.from('A local document for testing language selection. No translation is requested.')});
    const documentLanguage = page.getByRole('combobox',{name:'文档目标语言',exact:true});
    await documentLanguage.waitFor(); await open(documentLanguage,'document-language-menu');
    check(await popup().evaluate(el => Boolean(el.closest('.document-app'))), '文档菜单仍挂载到文档应用内部');
    check(await popup().evaluate(el => el.getBoundingClientRect().width >= 200), '窄选择框的长语言列表保持可读宽度'); await close(documentLanguage);
    check(report.consoleErrors.length === 0, '本轮选择器回归没有 console/page 错误');
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      const file = path.join(output,'failure.png'); await page.screenshot({path:file}).catch(()=>{}); report.screenshots.push(file);
      report.failureText = await page.locator('body').innerText().catch(()=> '');
    }
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await session?.close(); fs.rmSync(profileDir,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({ok:report.ok,cases:report.caseCoverage.length,error:report.error,screenshots:report.screenshots.length})+'\n');
})();
