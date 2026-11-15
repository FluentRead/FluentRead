#!/usr/bin/env node
/**
 * @file scripts/testing/run-translation-mutation-test.cjs
 * 在临时、无前台激活的 Edge 中验证翻译 DOM 所有权：宿主 tabindex 修饰不得重建译文，
 * 单语槽须承受邻接 DOM/样式变化，固定高度交互控件必须原位单行翻译并保留事件。
 * 页面使用精确域名夹具，微软请求在测试 worker 中返回确定性响应；禁止外部网络及日常 profile。
 * 断言基于宿主 DOM 的完整 outerHTML，因此证据截图必须保持非侵入（caret: 'initial'），
 * 不得让 Playwright 自身的 caret 隐藏在宿主 input/textarea 上留下残留属性。
 */
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {controlledProviderRuntime} = require('../site-translation/controlled-provider.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');

const root = path.resolve(__dirname, '../..');
const ownedSelector = '.fluent-read-bilingual-content, .fluent-read-single-slot';
const controlsSelector = '#merge-button, #merge-menu, #save-button, #menu-action, #split-button';
// 统一替换式按钮语义的回归对象：按钮型 input 的标签在 value 属性上，按钮化链接、
// 表单标签、ARIA 控件和自定义可聚焦控件的标签在文本节点上，三类都必须只出译文。
const buttonFormsSelector = '#submit-anonymous, #button-input, #reset-input, #button-link,' +
  ' #hint-link, #upload-label, #custom-action, #preview-tab';
// 参与表单提交的具名 submit 和用户输入内容必须原样保留。
const untouchedFormsSelector = '#submit-named, #text-input';

function parseArgs(argv) {
  const result = {helperPath: path.join(__dirname, 'focus-safe-browser.cjs'), timeout: 30000, display: 'secondary', browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
  const names = {'--extension-dir': 'extensionDir', '--playwright-root': 'playwrightRoot', '--focus-safe-helper': 'helperPath',
    '--artifacts-dir': 'artifactsDir', '--case': 'caseId', '--timeout': 'timeout', '--display': 'display', '--browser-path': 'browserPath'};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--background') continue;
    assert.ok(names[name] && argv[index + 1] && !argv[index + 1].startsWith('--'), `无法识别参数或缺少值：${name}`);
    result[names[name]] = argv[++index];
  }
  for (const name of ['extensionDir', 'playwrightRoot', 'helperPath', 'artifactsDir']) assert.ok(result[name], `缺少 ${name}`);
  result.timeout = Number(result.timeout);
  assert.ok(Number.isFinite(result.timeout) && result.timeout >= 5000, 'timeout 必须至少为 5000 ms');
  for (const name of ['extensionDir', 'playwrightRoot', 'helperPath', 'artifactsDir']) result[name] = path.resolve(result[name]);
  return result;
}

async function installTracker(page) {
  await page.evaluate(({ownedSelector, controlsSelector, buttonFormsSelector, untouchedFormsSelector}) => {
    const ids = new WeakMap();
    let nextId = 0;
    const id = node => { if (!ids.has(node)) ids.set(node, ++nextId); return ids.get(node); };
    const events = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const [kind, nodes] of [['add', record.addedNodes], ['remove', record.removedNodes]]) {
          for (const node of nodes) {
            if (node.nodeType !== 1 || !(node.matches(ownedSelector) || node.querySelector(ownedSelector))) continue;
            events.push({kind, at: Date.now(), id: id(node), html: node.outerHTML.slice(0,1200)});
          }
        }
      }
    });
    observer.observe(document, {childList: true, subtree: true});
    window.translationMutationTest = {
      events,
      snapshot() {
        const controls = [...document.querySelectorAll(controlsSelector)].map(node => {
          const bounds = node.getBoundingClientRect();
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          const ranges = [];
          let text;
          while ((text = walker.nextNode())) {
            if (!text.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            for (const rect of range.getClientRects()) ranges.push({text: text.textContent,
              inside: rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5 &&
                rect.left >= bounds.left - 0.5 && rect.right <= bounds.right + 0.5});
          }
          return {id: node.id, identity: id(node), html: node.innerHTML, text: node.textContent,
            height: bounds.height, ranges, wrappers: node.querySelectorAll('.fluent-read-bilingual-content').length,
            segments: node.querySelectorAll('[data-fr-translation-segment="true"]').length, clickCount: node.dataset.clickCount};
        });
        const formSnapshot = selector => [...document.querySelectorAll(selector)].map(node => ({
          id: node.id, tag: node.tagName.toLowerCase(), value: node.getAttribute('value'),
          text: node.textContent.replace(/\s+/g, ' ').trim(), html: node.outerHTML,
          height: Math.round(node.getBoundingClientRect().height),
          wrappers: node.querySelectorAll('.fluent-read-bilingual-content').length,
          segments: node.querySelectorAll('[data-fr-translation-segment="true"]').length,
        }));
        return {url: location.href, at: Date.now(), controls,
          buttonForms: formSnapshot(buttonFormsSelector), untouchedForms: formSnapshot(untouchedFormsSelector),
          hostFocusDecorations: window.hostFocusDecorations || 0,
          owned: [...document.querySelectorAll(ownedSelector)].map(node => ({identity: id(node), tag: node.className,
            parentId: node.parentElement?.id, text: node.textContent, translate: node.getAttribute('translate'),
            translationLabel: node.getAttribute('aria-label'),
            sourceTextIdentity: node.firstChild ? id(node.firstChild) : null})),
          nested: document.querySelectorAll('.fluent-read-bilingual-content .fluent-read-bilingual-content').length,
          titleHtml: document.querySelector('#commit-title')?.innerHTML,
          singleHtml: document.querySelector('#single-prose')?.innerHTML};
      },
    };
  }, {ownedSelector, controlsSelector, buttonFormsSelector, untouchedFormsSelector});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const helper = require(args.helperPath);
  for (const name of ['launchFocusSafePersistentContext', 'newPageWithoutForeground', 'activateExtensionTabWithoutForeground']) {
    assert.equal(typeof helper[name], 'function', `focus-safe helper 缺少 ${name}`);
  }
  const {chromium} = createRequire(path.join(args.playwrightRoot, '__fluentread_mutation_test__.cjs'))('playwright');
  assertFreshProductionExtension(args.extensionDir, root);
  fs.mkdirSync(args.artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-translation-mutation-'));
  const report = {scope: 'production-extension-domain-fixtures', provider: 'microsoft-local-deterministic-response',
    profileMode: 'new-temporary-profile', extensionDir: args.extensionDir, cases: [], errors: []};
  const save = () => fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  let session, context, worker, popup, primaryError, sequence = 0;
  const installedWorkers = new WeakMap();
  const installWorker = current => {
    if (!installedWorkers.has(current)) installedWorkers.set(current, current.evaluate(controlledProviderRuntime, true).then(() => current.evaluate(() => {
      globalThis.translationMutationRequests = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') {
          throw new Error(`External worker fetch disabled: ${url.origin}`);
        }
        const texts = JSON.parse(init?.body ?? await input.text());
        globalThis.translationMutationRequests.push({at: Date.now(), texts});
        const labels = {'Merge pull request': '合并拉取请求', 'Save changes': '保存更改', 'Open settings': '打开设置',
          'Review': '审查', 'changes': '更改'};
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text: labels[text] || globalThis.__frCompatibilityTransport.encode(text, 'microsoft-escaped-text')}]}))),
          {status: 200, headers: {'content-type': 'application/json'}});
      };
    })));
    return installedWorkers.get(current);
  };
  const patchConfig = async updates => {
    const response = await popup.evaluate(async ({updates, sequence}) => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!read.success) throw new Error(read.error || '配置读取失败');
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      const expected = Object.fromEntries(Object.keys(updates).map(key => [key, config[key]]));
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates, expected,
        clientId: 'translation-mutation-browser', sequence, baseRevision: config.__fluentConfigRevision});
    }, {updates, sequence: ++sequence});
    assert.equal(response.success, true, JSON.stringify(response));
  };
  const toggle = async page => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    await page.keyboard.down('Alt');
    await page.keyboard.press('t');
    await page.keyboard.up('Alt');
  };
  const snapshot = async page => ({...await page.evaluate(() => window.translationMutationTest.snapshot()),
    requests: await worker.evaluate(() => globalThis.translationMutationRequests.length)});
  // Playwright 默认 caret:'hide' 会给每个 input/textarea/[contenteditable] 写入
  // caret-color 再以空值清除，在宿主控件上留下空 style 属性。DOM 所有权断言必须
  // 比对完整 outerHTML，因此证据截图一律使用 caret:'initial'，不改写被断言的页面。
  const capture = (page, name) => page.screenshot({path: path.join(args.artifactsDir, name), caret: 'initial'});
  let launchAttempted = false;
  try {
  report.build = Object.fromEntries(['manifest.json', 'content-scripts/content.js'].map(name => {
    const file = path.join(args.extensionDir, name);
    return [name, {mtime: fs.statSync(file).mtime.toISOString(), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}];
  }));
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir, browserPath: args.browserPath,
      background: true, headless: false, viewport: {width: 1280, height: 900}, displayTarget: args.display,
      timeout: args.timeout, browserArgs: [`--disable-extensions-except=${args.extensionDir}`,
        `--load-extension=${args.extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir);
    context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    context.on('serviceworker', current => { void installWorker(current).catch(error => report.errors.push(error.message)); });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: args.timeout});
    await installWorker(worker);
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/translation-pages/mutation-focus-links.html'), 'utf8');
    const buttonFixture = fs.readFileSync(path.join(root, 'tests/fixtures/translation-pages/button-controls.html'), 'utf8');
    const cases = [
      {id: 'generic-focus', url: 'https://example.com/fluentread-focus-fixture', html: fixture, display: 1},
      {id: 'github-focus', url: 'https://github.com/FluentRead/FluentRead/pull/447/commits', html: fixture, display: 1},
      {id: 'button-controls', url: 'https://example.com/fluentread-button-fixture', html: buttonFixture, display: 1},
      {id: 'single-slots', url: 'https://github.com/FluentRead/FluentRead/issues/451', html: fixture, display: 0},
    ];
    await context.route('**/*', async route => {
      const request = route.request();
      const item = cases.find(item => item.url === request.url());
      if (item && request.isNavigationRequest()) return route.fulfill({status: 200, contentType: 'text/html', body: item.html});
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort('blockedbyclient');
      return route.continue();
    });
    popup = await helper.newPageWithoutForeground(context, args.timeout);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`, {waitUntil: 'domcontentloaded'});
    await popup.waitForTimeout(600);
    report.config = {service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false,
      hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0, fullPageTranslationMode: 'all',
      useCache: false, enableAIContext: false, enableAIMultiSegment: false, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true};
    await patchConfig(report.config);
    if (args.caseId) assert.ok(cases.some(item => item.id === args.caseId), `未知 case：${args.caseId}`);
    for (const item of cases.filter(item => !args.caseId || item.id === args.caseId)) {
      await patchConfig({display: item.display});
      const page = await helper.newPageWithoutForeground(context, args.timeout);
      const result = {id: item.id, display: item.display};
      let caseError;
      report.cases.push(result);
      page.on('pageerror', error => report.errors.push({case: item.id, error: error.message}));
      try {
        await page.goto(item.url, {waitUntil: 'domcontentloaded', timeout: args.timeout});
        await page.waitForSelector('#fluent-read-page-styles', {state: 'attached', timeout: args.timeout});
        await page.waitForTimeout(600);
        await installTracker(page);
        result.before = await snapshot(page);
        await capture(page, `${item.id}-before.png`);
        await toggle(page);
        await page.waitForFunction(selector => document.querySelectorAll(selector).length > 0, ownedSelector, {timeout: args.timeout});
        await page.waitForFunction(selector => {
          const state = window.translationMutationTest;
          const signature = document.querySelectorAll(selector).length + ':' +
            document.querySelectorAll('.fluent-read-loading, .fluent-read-retry-wrapper').length;
          if (state.settledSignature !== signature) {
            state.settledSignature = signature;
            state.settledAt = Date.now();
          }
          return signature.endsWith(':0') && Date.now() - state.settledAt >= 1800;
        }, ownedSelector, {timeout: args.timeout});
        result.first = await snapshot(page);
        await capture(page, `${item.id}-translated.png`);
        if (item.id === 'single-slots') {
          await page.evaluate(() => {
            const owner = document.querySelector('#single-prose');
            owner.classList.add('host-layout-active');
            const decoration = document.createElement('span');
            decoration.setAttribute('aria-hidden', 'true');
            decoration.textContent = '●';
            decoration.id = 'host-decoration';
            owner.append(decoration);
          });
          await page.waitForTimeout(350);
          await page.evaluate(() => {
            document.querySelector('#host-decoration').remove();
            document.querySelector('#single-prose').classList.remove('host-layout-active');
          });
        } else if (item.id.endsWith('-focus')) {
          await page.evaluate(() => {
            for (const anchor of document.querySelectorAll('.fluent-read-bilingual-content a')) anchor.tabIndex = 0;
          });
          await page.waitForTimeout(350);
          await page.evaluate(() => {
            for (const anchor of document.querySelectorAll('.fluent-read-bilingual-content a')) anchor.tabIndex = -1;
          });
        }
        await page.waitForTimeout(1800);
        result.stable = await snapshot(page);
        result.events = await page.evaluate(() => window.translationMutationTest.events);
        assert.equal(result.events.filter(event => event.kind === 'remove').length, 0, `${item.id}: 宿主无害变更移除了译文`);
        assert.deepEqual(result.stable.owned, result.first.owned, `${item.id}: 译文或源 Text identity 变化`);
        assert.equal(result.stable.requests, result.first.requests, `${item.id}: 无害变更多发翻译请求`);
        assert.equal(result.stable.nested, 0);
        if (item.id.endsWith('-focus')) {
          assert.equal(result.stable.owned.filter(node => node.parentId === 'commit-title').length, 1);
          assert.ok(result.stable.hostFocusDecorations > result.before.hostFocusDecorations, '宿主必须实际修饰过译文链接');
        }
        if (item.id === 'single-slots') {
          assert.ok(result.stable.owned.length > 0);
          assert.ok(result.stable.owned.every(node => node.tag.includes('fluent-read-single-slot') && node.translate === 'no' && /[\u3400-\u9fff]/u.test(node.translationLabel || '')));
        }
        if (item.id === 'button-controls') {
          for (const control of result.stable.controls) {
            assert.equal(control.height, 32, control.id);
            assert.equal(control.wrappers, 0, `${control.id}: 控件中不应增加双语块`);
            assert.equal(control.segments, 0, `${control.id}: 控件中不应合成正文段`);
            assert.ok(control.ranges.every(range => range.inside), `${control.id}: 文字超出控件`);
            await page.locator(`#${control.id}`).click();
            assert.equal(await page.locator(`#${control.id}`).getAttribute('data-click-count'), '1');
          }
          assert.equal(result.stable.controls.find(control => control.id === 'merge-button').text, '合并拉取请求');

          // 所有按钮形态统一采用替换式译文：不插入双语块，不合成正文段，不撑出第二行。
          const hasChinese = value => /[\u3400-\u9fff]/u.test(value || '');
          assert.equal(result.stable.buttonForms.length, 8);
          for (const form of result.stable.buttonForms) {
            assert.equal(form.wrappers, 0, `${form.id}: 按钮中不应增加双语块`);
            assert.equal(form.segments, 0, `${form.id}: 按钮中不应合成正文段`);
            assert.equal(form.height, 32, `${form.id}: 按钮译文撑破了固定高度`);
            const label = form.tag === 'input' ? form.value : form.text;
            assert.ok(hasChinese(label), `${form.id}: 按钮标签未替换为译文（${label}）`);
          }
          // 具名 submit 的 value 会随表单提交，输入框 value 是用户数据；二者既不能改写，
          // 也不能被属性或译文工件触碰，因此整段 outerHTML 必须与翻译前完全一致。
          assert.equal(result.stable.untouchedForms.length, 2);
          for (const form of result.stable.untouchedForms) {
            const original = result.before.untouchedForms.find(item => item.id === form.id);
            assert.equal(form.html, original.html, `${form.id}: 非候选表单控件被翻译改写`);
            assert.equal(form.wrappers + form.segments, 0, `${form.id}: 表单控件中出现了译文工件`);
          }
        }
        await toggle(page);
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, ownedSelector, {timeout: args.timeout});
        await page.waitForTimeout(400);
        result.restored = await snapshot(page);
        assert.equal(result.restored.url, item.url);
        assert.equal(result.restored.titleHtml, result.before.titleHtml);
        assert.equal(result.restored.singleHtml, result.before.singleHtml);
        for (const control of result.restored.controls) {
          assert.equal(control.html, result.before.controls.find(original => original.id === control.id).html);
        }
        for (const form of [...result.restored.buttonForms, ...result.restored.untouchedForms]) {
          const original = [...result.before.buttonForms, ...result.before.untouchedForms]
            .find(item => item.id === form.id);
          assert.equal(form.value, original.value, `${form.id}: 恢复原文后未回到原始按钮标签`);
          assert.equal(form.text, original.text, `${form.id}: 恢复原文后仍残留译文`);
          assert.equal(form.wrappers + form.segments, 0, `${form.id}: 恢复原文后仍残留译文工件`);
          assert.equal(form.html, original.html, `${form.id}: 恢复原文后仍残留属性或样式`);
        }
        await toggle(page);
        await page.waitForFunction(({selector, count}) => document.querySelectorAll(selector).length === count,
          {selector: ownedSelector, count: result.first.owned.length}, {timeout: args.timeout});
        await page.waitForTimeout(1000);
        result.retranslated = await snapshot(page);
        assert.equal(result.retranslated.url, item.url);
        assert.equal(result.retranslated.nested, 0);
        for (const form of result.retranslated.buttonForms) {
          const first = result.first.buttonForms.find(original => original.id === form.id);
          assert.equal(form.tag === 'input' ? form.value : form.text,
            first.tag === 'input' ? first.value : first.text, `${form.id}: 再次翻译的标签不一致`);
          assert.equal(form.height, 32, `${form.id}: 再次翻译后撑破了固定高度`);
        }
        for (const control of result.retranslated.controls) {
          const first = result.first.controls.find(original => original.id === control.id);
          assert.equal(control.identity, first.identity);
          assert.equal(control.text, first.text);
          assert.ok(control.ranges.every(range => range.inside));
          await page.locator(`#${control.id}`).click();
          assert.equal(await page.locator(`#${control.id}`).getAttribute('data-click-count'), '2');
        }
        await capture(page, `${item.id}-retranslated.png`);
        result.passed = true;
        process.stdout.write(`${item.id}: passed; translated/restored/retranslated ${result.first.owned.length}/0/${result.retranslated.owned.length}\n`);
      } catch (error) {
        caseError = error;
        result.error = error.stack;
        try {
          result.failure = await snapshot(page).catch(() => null);
          result.events = await page.evaluate(() => window.translationMutationTest?.events || []).catch(() => []);
          result.requests = await worker.evaluate(() => globalThis.translationMutationRequests).catch(() => []);
          await capture(page, `${item.id}-failure.png`).catch(() => {});
        } catch (diagnosticError) { console.error('Failure diagnostics failed:', diagnosticError); }
        throw error;
      } finally {
        const caseCleanupErrors = [];
        const releaseCase = async (resource, release) => {
          try { await release(); } catch (error) {
            caseCleanupErrors.push(error);
            (report.cleanupErrors ||= []).push({resource, case: item.id, error: String(error.stack || error)});
            report.passed = false;
            process.exitCode = 1;
            console.error(`Cleanup failed (${resource}):`, error);
          }
        };
        await releaseCase('case report', save);
        await releaseCase('case page', () => page.close());
        if (caseCleanupErrors.length && !caseError) throw caseCleanupErrors[0];
      }
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    primaryError = error;
    report.error = error.stack;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try { await release(); } catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.passed = false;
        process.exitCode = 1;
        console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => { if (session) { await session.close(); browserClosed = true; } });
    await cleanup('profile', () => {
      if (!profileDir) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      else if (!launchAttempted) {
        try { fs.rmdirSync(profileDir); } catch (error) {
          // 未尝试启动浏览器时，仅移除初始空目录。
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    await cleanup('report', () => { save(); });
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
