'use strict';
/**
 * @file scripts/testing/run-settings-search-results-layout-test.cjs
 * 文件职责：在真实生产扩展中验证设置搜索结果面板的尺寸与对齐。
 * 主要内容：在通用设置、翻译服务和关于页验证单条、多条和无结果的查询，检查宽屏结果同列、窄屏搜索浮层边界、内容区尺寸与键盘焦点。
 * 模块边界：只使用临时 Edge profile 和不抢焦点 helper，不读取用户配置、不修改设置，也不代表 Firefox 实机表现。
 */
const fs = require('node:fs');
const path = require('node:path');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-search-results-layout'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper'));
const assert = (value, message) => { if (!value) throw new Error(message); };
const timeout = 30000;
const maximumPanelHeight = 260;
async function main() {
  const report = {ok: false, extensionDir, scope: '设置搜索结果面板的尺寸与对齐', cases: [], screenshots: [], consoleErrors: [], cleanupErrors: []};
  let launched, profileDir, profileIdentity;
  let launchAttempted = false;
  try {
    fs.mkdirSync(artifactsDir, {recursive: true});
    profileDir = fs.mkdtempSync('/private/tmp/fr-settings-search-results-');
    profileIdentity = fs.lstatSync(profileDir);
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({
      chromium, profileDir, timeout, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 900},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
    });
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout});
    const page = await newPageWithoutForeground(context, timeout);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const origin = `chrome-extension://${worker.url().split('/')[2]}`;
    const search = page.locator('.search-box input');
    const panel = page.locator('.search-results, .search-empty');
    async function measure() {
      return page.evaluate(() => {
        const rect = element => {
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return {left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height};
        };
        const box = document.querySelector('.search-results, .search-empty');
        const card = document.querySelector('.settings-card');
        const topbar = document.querySelector('.topbar');
        const fullBleed = card.matches('.services-view, .translation-center-view');
        return {
          kind: box.className, results: box.querySelectorAll('button').length,
          box: rect(box), clientHeight: box.clientHeight, scrollHeight: box.scrollHeight,
          topbar: getComputedStyle(topbar).display === 'none' ? null : rect(topbar),
          // 全宽工作台自行铺满工作区，面板只需留在工作区内边距内。
          column: fullBleed ? null : rect([...card.children].find(element => element.getBoundingClientRect().height > 0)),
          card: rect(card), viewport: {width: innerWidth, height: innerHeight},
        };
      });
    }
    for (const [width, height] of [[1440, 900], [1024, 700], [390, 720], [320, 480], [568, 320], [1440, 480]]) {
      await page.setViewportSize({width, height});
      for (const section of ['settings-general', 'settings-services', 'settings-about']) {
        await page.goto(`${origin}/options.html#${section}`, {waitUntil: 'domcontentloaded'});
        await page.locator(section === 'settings-services' ? '.service-catalog' : `#${section}`).waitFor({state: 'visible', timeout});
        const cardBeforeSearch = await page.locator('.settings-card').boundingBox();
        for (const [query, expectation] of [['langu', 'single'], ['翻译', 'many'], ['no-such-setting-xyz', 'empty']]) {
          const name = `${width}x${height} ${section} ${expectation}`;
          await search.fill(query);
          await panel.first().waitFor({state: 'visible', timeout});
          await page.waitForTimeout(150);
          const state = await measure();
          report.cases.push({name, query, ...state});
          const limit = Math.min(maximumPanelHeight, height * .4);
          assert(state.box.height <= limit + 1, `${name}: 面板超过高度上限 ${JSON.stringify(state.box)}`);
          if (expectation === 'many') {
            assert(state.results > 4 && state.scrollHeight > state.clientHeight, `${name}: 多条结果应在面板内滚动`);
            assert(state.box.height >= limit - 1, `${name}: 多条结果未用满面板高度 ${state.box.height}`);
          } else {
            assert(expectation === 'empty' ? state.kind === 'search-empty' : state.results === 1, `${name}: 结果数量异常 ${state.results}`);
            assert(state.scrollHeight <= state.clientHeight + 1, `${name}: 面板内容被裁切 ${state.clientHeight}/${state.scrollHeight}`);
          }
          if (width <= 700) {
            assert(state.box.top >= 0 && state.box.bottom <= height && state.box.left >= 0 && state.box.right <= width,
              `${name}: 搜索浮层超出视口 ${JSON.stringify(state.box)}`);
            assert(Math.abs(state.card.top - cardBeforeSearch.y) <= 1 && Math.abs(state.card.height - cardBeforeSearch.height) <= 1,
              `${name}: 搜索改变了窄屏设置区的高度或位置`);
          } else {
            for (const [label, reference] of [['页内导航', state.topbar], ['设置内容', state.column]]) {
              if (!reference) continue;
              assert(Math.abs(state.box.left - reference.left) <= 3 && Math.abs(state.box.right - reference.right) <= 3,
                `${name}: 面板未与${label}同列 ${JSON.stringify({box: state.box, reference})}`);
            }
            assert(state.box.bottom <= state.card.top + 1 && state.card.height >= 120, `${name}: 面板挤占设置内容 ${JSON.stringify(state.card)}`);
          }
          if (section === 'settings-general' || width === 1440 && height === 900) {
            const target = path.join(artifactsDir, `${width}x${height}-${section}-${expectation}.png`);
            await page.screenshot({path: target});
            report.screenshots.push(target);
          }
        }
        await search.fill('');
        await panel.first().waitFor({state: 'detached', timeout});
        if (width === 320 && section === 'settings-general') {
          await search.fill('翻译');
          const first = page.locator('.search-results button').first();
          await first.waitFor({state: 'visible', timeout});
          await search.press('ArrowDown');
          assert(await first.evaluate(button => button === document.activeElement), '方向键未进入搜索结果');
          await first.press('Escape');
          await panel.first().waitFor({state: 'detached', timeout});
          assert(await search.evaluate(input => input === document.activeElement), '关闭搜索后键盘焦点未返回搜索框');
        }
      }
    }
    assert(report.consoleErrors.length === 0, '浏览器控制台存在异常');
    report.ok = true;
  } catch (error) {
    report.error = error?.stack || String(error);
  } finally {
    // 未取得会话时，启动可能已部分完成；没有成功关闭的回执就保留 profile。
    let closed = !launchAttempted;
    if (launched) {
      try { await launched.close(); closed = true; }
      catch (error) { report.cleanupErrors.push(`session close: ${error?.stack || String(error)}`); }
    }
    if (profileDir) {
      if (closed && profileIdentity) {
        try {
          const current = fs.lstatSync(profileDir);
          assert(!current.isSymbolicLink() && current.ino === profileIdentity.ino && current.dev === profileIdentity.dev,
            'Temporary profile ownership changed');
          fs.rmSync(profileDir, {recursive: true, force: true});
          report.profileRemoved = true;
        } catch (error) {
          report.cleanupErrors.push(`profile removal: ${error?.stack || String(error)}`);
          report.retainedProfile = profileDir;
        }
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) report.ok = false;
    // 报告最后写入，写失败不跳过独立清理，也不覆盖最先发生的异常。
    try { fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2)); }
    catch (error) {
      report.cleanupErrors.push(`report write: ${error?.stack || String(error)}`);
      report.ok = false;
      console.error(error?.stack || String(error));
    }
  }
  console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, error: report.error,
    cleanupErrors: report.cleanupErrors, retainedProfile: report.retainedProfile, artifactsDir}));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
