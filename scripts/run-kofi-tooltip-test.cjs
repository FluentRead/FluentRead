#!/usr/bin/env node
// 只在显式指定的公开 Ko-fi 页面使用临时后台 Edge；翻译 transport 为本地延迟夹具。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readConfig, installTranslationFixtureOnWorker, toggleFullPage, startTranslationFixtureServer} = require('./run-full-page-translation-test.cjs');
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[i + 1]]);
    return pairs;
  }, []));
  if (args.url !== 'https://ko-fi.com/thinkstu') throw new Error('必须显式指定 --url https://ko-fi.com/thinkstu');
  const {chromium} = require(path.join(args['playwright-root'], 'playwright'));
  const safe = require(args['focus-safe-helper']);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-kofi-'));
  const artifacts = args['artifacts-dir'];
  fs.mkdirSync(artifacts, {recursive: true});
  const unexpected = [];
  const fixture = await startTranslationFixtureServer(unexpected, 1200);
  let session;
  try {
    const extension = path.resolve(args['extension-dir']);
    session = await safe.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true, headless: false, viewport: {width: 1280, height: 900},
      browserArgs: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    const context = session.context;
    const createPage = () => safe.newPageWithoutForeground(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await installTranslationFixtureOnWorker(worker, {translationUrl: fixture.translationUrl, blockedUrl: fixture.blockedUrl});
    await readConfig(context, 30000, {animations: true, translationLoadingStyle: 'sparkle'}, createPage);
    const page = await createPage();
    await page.goto(args.url, {waitUntil: 'domcontentloaded', timeout: 45000});
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    const trigger = page.locator('i[data-original-title="Support ThinkStu monthly"]:visible').first();
    await trigger.waitFor();
    await page.mouse.move(0, 0);
    await toggleFullPage(page, p => safe.activateExtensionTabWithoutForeground(context, p));
    await page.waitForFunction(() => {
      const trigger = [...document.querySelectorAll('i[data-original-title="Support ThinkStu monthly"]')]
        .find(el => el.getBoundingClientRect().width > 0);
      return trigger?.parentElement?.textContent.includes('测试译文') && !document.querySelector('.fluent-read-loading');
    }, undefined, {timeout: 45000});
    await page.waitForTimeout(1500);
    await trigger.evaluate(el => {
      window.kofiHover = {enters: 0, leaves: 0, loadingFrames: 0, translatedFrames: 0, missingFrames: 0, leavesDetail: []};
      el.addEventListener('mouseenter', () => window.kofiHover.enters++);
      el.addEventListener('mouseleave', () => {
        window.kofiHover.leaves++;
        if (window.kofiHover.leavesDetail.length < 3) window.kofiHover.leavesDetail.push({parent:el.parentElement.outerHTML,rect:el.getBoundingClientRect().toJSON(),tip:[...document.querySelectorAll('.tooltip')].map(t=>({html:t.outerHTML,pointer:getComputedStyle(t).pointerEvents}))});
      });
      const sample = () => {
        const tooltip = [...document.querySelectorAll('.tooltip')].find(t => t.textContent.includes('Support ThinkStu monthly'));
        if (!tooltip) window.kofiHover.missingFrames++;
        if (tooltip?.querySelector('.fluent-read-loading')) window.kofiHover.loadingFrames++;
        if (tooltip && /测试译文/.test(tooltip.textContent)) window.kofiHover.translatedFrames++;
        window.kofiRaf = requestAnimationFrame(sample);
      };
      window.kofiRaf = requestAnimationFrame(sample);
    });
    await trigger.hover();
    await page.waitForTimeout(6000);
    const report = await page.evaluate(() => {
      cancelAnimationFrame(window.kofiRaf);
      return {hover: window.kofiHover, tooltips: [...document.querySelectorAll('.tooltip')].map(el => el.outerHTML)};
    });
    await page.screenshot({path: path.join(artifacts, 'hover.png')});
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    report.closed = await page.locator('.tooltip:visible').count() === 0;
    await trigger.hover();
    await page.waitForTimeout(3500);
    report.secondHover = await page.evaluate(() => ({
      enters: window.kofiHover.enters, leaves: window.kofiHover.leaves,
      translated: [...document.querySelectorAll('.tooltip')].some(el => /测试译文/.test(el.textContent)),
    }));
    await page.mouse.move(0, 0);
    await toggleFullPage(page, p => safe.activateExtensionTabWithoutForeground(context, p));
    await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content, [data-fr-tooltip-translation-active="true"]'));
    report.restoredLabel = await trigger.evaluate(el => el.parentElement.querySelector('span')?.textContent.trim());
    report.restored = report.restoredLabel === 'Monthly';
    await trigger.hover();
    await page.waitForTimeout(1000);
    report.originalTooltip = await page.locator('.tooltip:visible .tooltip-inner').innerText();
    report.launchMode = session.launchMode;
    report.focusPolicy = session.focusPolicy;
    report.windowPlacement = session.windowPlacement;
    report.transport = 'loopback Microsoft response fixture, 1200ms delay';
    report.unexpectedProviderRequests = unexpected;
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.hover.enters !== 1 || report.hover.leaves !== 0 || report.hover.translatedFrames === 0 || !report.closed || report.secondHover.enters !== 2 || report.secondHover.leaves !== 1 || !report.secondHover.translated || !report.restored || report.originalTooltip !== 'Support ThinkStu monthly') throw new Error('Ko-fi tooltip 悬停不稳定');
  } finally {
    await session?.close();
    await fixture.close();
    fs.rmSync(profileDir, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
