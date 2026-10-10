// 输入框翻译专项：生产扩展、隔离 Edge、真实按键和本地确定性供应商响应。
const {waitForAsyncCondition} = require('./testing/wait-for-async-condition.cjs');
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const argument = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const {chromium} = require(path.join(argument('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
const helper = require(argument('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs')));
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-input-translation'));
fs.mkdirSync(artifactsDir, {recursive: true});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-input-translation-'));
const report = {extensionDir, profileDir, evidence: 'Production extension; real browser input; deterministic mock provider, no external provider certification', cases: [], consoleErrors: []};
let session;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>输入框翻译 · 交互验证</title><style>
body{margin:0;padding:48px;background:#f5f3f7;color:#292337;font:16px/1.7 system-ui}main{max-width:820px;margin:auto;background:white;border-radius:20px;padding:32px}h1{margin:0;font-size:26px}p{color:#696275}label{display:block;margin:24px 0}input,textarea,[contenteditable]{box-sizing:border-box;width:100%;padding:14px;border:1px solid #cfc8da;border-radius:10px;font:18px/1.6 system-ui}textarea{min-height:130px}small{color:#81758b}
</style></head><body><main><h1>输入框翻译</h1><p>输入、触发、继续编辑与恢复原文</p><label>消息<textarea id="message">明天下午见面。</textarea></label><label>另一输入框<input id="other" value="请帮我确认时间。"></label><label>密码<input id="password" type="password" value="private"></label><label>富文本编辑区<div id="rich" contenteditable="true"><b>这段格式需要保留。</b></div></label><label>模型驱动编辑器<div id="model" contenteditable="true"></div></label><label>拒绝粘贴的模型编辑器<div id="blocked-paste" contenteditable="true"><b>拒绝粘贴时保留格式。</b></div></label><label>原生写入未提交的编辑器<div id="blocked-native" contenteditable="true"><b>原生写入未提交时保留格式。</b></div></label><label>纯文本编辑区<div id="plain" contenteditable="plaintext-only">你好</div></label><label>代码编辑器<div class="cm-editor"><div id="code" class="cm-content" contenteditable="true">const a = 1;</div></div></label><small>本页使用本地测试响应，验证扩展交互。</small></main><script>
// 模拟 Lexical/Draft.js：拦截 beforeinput 与 paste，只在 selectionchange 事件里同步模型选区，再由模型重新渲染 DOM。
(() => {
  const root = document.getElementById('model');
  const model = {text: '模型编辑器原文。', start: 0, end: 0};
  const log = window.modelEditorLog = [];
  const render = () => {
    root.textContent = model.text;
    if (document.activeElement !== root || !root.firstChild) return;
    const range = document.createRange();
    range.setStart(root.firstChild, model.start);
    range.setEnd(root.firstChild, model.end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  };
  const offset = (node, value) => node === root ? (value === 0 ? 0 : model.text.length) : value;
  document.addEventListener('selectionchange', event => {
    const selection = getSelection();
    if (!selection.rangeCount || !root.contains(selection.anchorNode)) return;
    if (window.holdModelSelection && selection.toString() === model.text) {
      window.modelSelectionHeld = true;
      event.stopImmediatePropagation();
      return;
    }
    const range = selection.getRangeAt(0);
    model.start = offset(range.startContainer, range.startOffset);
    model.end = offset(range.endContainer, range.endOffset);
  }, {capture: true});
  const replace = (text, source) => {
    log.push({source, start: model.start, end: model.end, length: model.text.length, text});
    model.text = model.text.slice(0, model.start) + text + model.text.slice(model.end);
    model.start = model.end = model.start + text.length;
    render();
  };
  root.addEventListener('beforeinput', event => {
    if (event.inputType !== 'insertText') return;
    event.preventDefault();
    replace(event.data || '', 'beforeinput');
  });
  root.addEventListener('paste', event => {
    event.preventDefault();
    replace(event.clipboardData.getData('text/plain'), 'paste');
  });
  window.resetModelEditor = text => {
    model.text = text;
    model.start = model.end = text.length;
    render();
  };
  window.blockedEditorLog = [];
  document.getElementById('blocked-paste').addEventListener('paste', event => {
    event.preventDefault();
    window.blockedEditorLog.push({id: 'blocked-paste', source: 'paste', text: event.clipboardData.getData('text/plain')});
  });
  document.getElementById('blocked-native').addEventListener('paste', event => {
    window.blockedEditorLog.push({id: 'blocked-native', source: 'paste', text: event.clipboardData.getData('text/plain')});
  });
  document.getElementById('message').addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter') window.pageSawCtrlEnter = true;
  });
  render();
})();
</script></body></html>`;

async function main() {
  let primaryError;
  let launchAttempted = false;
  let captureInputFixture;
  try {
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true,
      headless: false, viewport: {width: 1280, height: 900}, displayTarget: 'secondary', timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking']});
    guardBrowserClose(session, profileDir);
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    const context = session.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      globalThis.inputTest = {mode: 'success', requests: [], pending: [], aborted: 0, result: 'Let us meet tomorrow afternoon.'};
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.protocol === 'chrome-extension:') return originalFetch(input, init);
        const state = globalThis.inputTest;
        const body = JSON.parse(init?.body || '{}');
        state.requests.push({url: url.href, body});
        if (state.mode === 'pending') await new Promise((resolve, reject) => {
          const signal = init?.signal || (typeof input === 'object' ? input.signal : undefined);
          let settled = false;
          const finish = action => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            action();
          };
          const onAbort = () => finish(() => {
            state.aborted += 1;
            reject(new DOMException('input fixture request aborted', 'AbortError'));
          });
          state.pending.push(() => finish(resolve));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, {once: true});
        });
        if (state.mode === 'failure') return new Response('simulated failure', {status: 503});
        const payload = Array.isArray(body)
          ? body.map(() => ({translations: [{text: state.result}]}))
          : {id: 'input-fixture', object: 'chat.completion', created: 1, model: body.model,
            choices: [{index: 0, message: {role: 'assistant', content: state.result}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 12, completion_tokens: 8, total_tokens: 20}};
        return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    captureInputFixture = async () => {
      const state = await worker.evaluate(() => ({requests: globalThis.inputTest.requests, aborted: globalThis.inputTest.aborted}));
      report.runtimeRequests = state.requests;
      report.providerAbortCount = state.aborted;
    };
    const options = await helper.newPageWithoutForeground(context);
    options.on('pageerror', error => report.consoleErrors.push(error.message));
    await options.goto(`chrome-extension://${extensionId}/options.html#settings-translation`);
    await options.locator('.settings-section').first().waitFor({state: 'attached'});
    let sequence = 0;
    async function readConfig() {
      return options.evaluate(async () => {
        const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      });
    }
    async function patch(updates) {
      const result = await options.evaluate(async ({updates, sequence}) => {
        const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const current = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
          expected: Object.fromEntries(Object.keys(updates).map(key => [key, current[key]])),
          clientId: 'input-translation-browser-test', sequence, baseRevision: current.__fluentConfigRevision});
      }, {updates, sequence: ++sequence});
      assert.equal(result.success, true, JSON.stringify(result));
      await pause(400);
    }
    async function snap(name, page = options) {
      await pause(350); // Let dialog and theme transitions settle before capturing evidence.
      const file = `${name}.png`;
      await page.screenshot({caret: 'initial', path: path.join(artifactsDir, file), animations: 'disabled'});
      for (const dialog of await page.locator('.input-translation-dialog.el-dialog').all()) {
        if (!await dialog.isVisible()) continue;
        const bounds = await dialog.boundingBox();
        const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
        report.dialogComputed ||= {};
        report.dialogComputed[name] = await dialog.evaluate(el => ({panel: {height: getComputedStyle(el).height, maxHeight: getComputedStyle(el).maxHeight, display: getComputedStyle(el).display}, body: {height: getComputedStyle(el.querySelector('.el-dialog__body')).height, overflow: getComputedStyle(el.querySelector('.el-dialog__body')).overflowY}}));
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, `dialog stays inside viewport: ${name} ${JSON.stringify(bounds)}`);
        report.dialogGeometry ||= {};
        report.dialogGeometry[name] = bounds;
      }
      return file;
    }
    async function selectTestId(testId, label) {
      await options.getByTestId(testId).click();
      await options.locator('.el-select-dropdown:visible').getByRole('option', {name: label, exact: true}).click();
      await pause(400); // Settings persist asynchronously through the background page.
    }
    const defaults = await readConfig();
    assert.equal(defaults.inputBoxTranslationInterval, 1000);
    assert.equal(defaults.inputBoxTranslationService, '', 'new input profiles follow the configured default service');
    await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, useCache: false,
      inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationTarget: 'en',
      inputBoxTranslationInterval: 600, inputBoxTranslationService: 'microsoft',
      hotkey: 'disabled', selectionTranslatorMode: 'disabled', floatingBallPosition: 'disabled',
      translationMaxRetries: 0});
    await options.reload();
    const group = options.getByTestId('input-translation-settings');
    const profileEditor = options.getByTestId('input-translation-profile-editor');
    const promptEditor = options.getByTestId('input-translation-prompts');
    async function openProfile() {
      await profileEditor.waitFor({state: 'visible'});
    }
    async function openPrompts() {
      await openProfile();
      const toggle = options.getByTestId('input-translation-prompt-toggle');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await promptEditor.waitFor({state: 'visible'});
    }
    await group.waitFor({state: 'visible'});
    await group.scrollIntoViewIfNeeded();
    assert.equal(await group.locator('.input-translation-connection-link').count(), 0);
    assert.equal(await group.getByText('选择已配置且当前可用的翻译服务。', {exact: true}).count(), 0);
    assert.equal(defaults.inputBoxTranslationOutputMode, 'replace');
    const closingOptions = await helper.newPageWithoutForeground(context);
    closingOptions.on('pageerror', error => report.consoleErrors.push(error.message));
    await closingOptions.goto(`chrome-extension://${extensionId}/options.html#settings-translation`);
    await closingOptions.getByTestId('input-translation-output-mode').click();
    await closingOptions.locator('.el-select-dropdown:visible').getByRole('option', {name: '原文在前，译文在后', exact: true}).click();
    await closingOptions.close();
    await options.reload();
    await group.waitFor({state: 'visible'});
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    assert.ok((await group.textContent()).includes('保留原文并换行追加'));
    await snap('00-bilingual-output-settings');
    report.quickClose = {field: 'inputBoxTranslationOutputMode', reopened: 'append', passed: true};
    await selectTestId('input-translation-output-mode', '替换原文');
    await selectTestId('input-translation-output-mode', '原文在前，译文在后');
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    report.latestWriteWins = {field: 'inputBoxTranslationOutputMode', finalValue: 'append', passed: true};
    await selectTestId('input-translation-output-mode', '替换原文');
    report.cases.push({name: 'output mode quick-close persistence and latest write wins; redundant service text removed', passed: true});
    report.initialConfig = Object.fromEntries(Object.entries(await readConfig()).filter(([key]) => key.startsWith('inputBoxTranslation') || key === 'on'));
    await snap('00-initial-settings');
    await options.getByTestId('input-translation-timing-toggle').click();
    const interval = options.getByTestId('input-translation-interval').locator('input');
    await interval.fill('750');
    await interval.press('Tab');
    await waitForAsyncCondition(() => options.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return (typeof r.value === 'string' ? JSON.parse(r.value) : r.value).inputBoxTranslationInterval === 750;
    }), {timeoutMs: 30000, message: "输入框翻译间隔未持久化为 750ms"});
    await options.reload();
    await group.scrollIntoViewIfNeeded();
    assert.equal((await readConfig()).inputBoxTranslationInterval, 750);
    report.quickClose.interval = {value: 750, persistedAfterReload: true};
    await options.getByTestId('input-translation-timing-toggle').click();
    await options.getByTestId('input-translation-interval-reset').click();
    await pause(350);
    assert.equal((await readConfig()).inputBoxTranslationInterval, 1000);
    report.cases.push({name: 'interval edit and restore default', passed: true});
    await snap('01-timing-panel');
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await options.getByTestId('input-translation-timing-panel').waitFor({state: 'hidden'});
    await snap('01-settings-machine');

    const saved = await readConfig();
    await patch({service: 'microsoft', requireApiKey: {...saved.requireApiKey, 'v2:["openai","gpt-4.1-nano"]': false, 'v2:["openai","gpt-4.1-mini"]': false}, proxy: {...saved.proxy, openai: 'http://127.0.0.1:11434/v1/chat/completions'},
      model: {...saved.model, openai: 'gpt-4.1-mini'},
      user_role: {...saved.user_role, openai: 'GLOBAL PROMPT {{origin}} {{to}}'},
      system_role: {...saved.system_role, openai: 'GLOBAL SYSTEM'},
      inputBoxTranslationService: 'microsoft', inputBoxTranslationModel: '',
      inputBoxTranslationPrompt: '', inputBoxTranslationSystemPrompt: ''});
    const globalBefore = await readConfig();
    await options.reload();
    await group.scrollIntoViewIfNeeded();
    await selectTestId('input-translation-trigger', '已关闭');
    assert.ok((await group.textContent()).includes('选择一个快捷键'));
    await openProfile();
    await selectTestId('input-translation-service', 'OpenAI');
    await selectTestId('input-translation-model', 'gpt-4.1-nano');
    assert.equal((await readConfig()).inputBoxTranslationModel, 'gpt-4.1-nano', 'selecting a model updates the independent input translation profile');
    await openPrompts();
    await options.getByTestId('input-translation-system-default').click();
    await options.getByTestId('input-translation-user-default').click();
    assert.ok((await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue()).includes('professional translation assistant'));
    assert.ok((await promptEditor.locator('[data-prompt-role="user"] textarea').inputValue()).includes('{{origin}}'));
    await pause(400);
    await options.reload();
    await openPrompts();
    assert.ok((await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue()).includes('professional translation assistant'));
    await promptEditor.getByRole('button', {name: '重置此提示词，不影响其他提示词', exact: true}).first().click();
    await promptEditor.getByRole('button', {name: '重置此提示词，不影响其他提示词', exact: true}).first().click();
    assert.equal(await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue(), '');
    assert.equal(await promptEditor.locator('[data-prompt-role="user"] textarea').inputValue(), '');
    await promptEditor.locator('[data-prompt-role="system"] textarea').fill('   ');
    await promptEditor.locator('[data-prompt-role="user"] textarea').fill('\n  ');
    assert.ok((await options.getByTestId('input-translation-prompt-toggle').textContent()).includes('当前使用独立默认提示词'));
    assert.equal(await promptEditor.getByRole('alert').count(), 0);
    report.cases.push({name: 'default prompts can be loaded, edited, persisted and reset; whitespace uses default semantics', passed: true});
    await promptEditor.locator('[data-prompt-role="system"] textarea').fill('Keep the message polite. Return only translated text.');
    await promptEditor.locator('[data-prompt-role="user"] textarea').fill('Translate this input into {{to}}: {{origin}}');
    await pause(500);
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationService, 'openai');
    assert.equal((await readConfig()).inputBoxTranslationModel, 'gpt-4.1-nano');
    assert.equal((await readConfig()).inputBoxTranslationSystemPrompt, 'Keep the message polite. Return only translated text.');
    await group.scrollIntoViewIfNeeded();
    assert.equal((await readConfig()).inputBoxTranslationTrigger, 'disabled', 'editing a profile must not enable translation');
    await selectTestId('input-translation-trigger', '连按三下等号(=)');
    assert.ok((await group.textContent()).includes('输入文字后，连按三下等号(=)，即可替换为英语'));
    assert.equal(await promptEditor.count(), 0, 'prompt editor is opened on demand');
    const desktopBounds = await group.boundingBox();
    assert.ok(desktopBounds.height < 600, `AI settings including bilingual output order fit one desktop screen: ${desktopBounds.height}`);
    report.settingsLayout = {desktopCardHeight: desktopBounds.height, promptEditorInitiallyClosed: true};
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await options.mouse.move(20, 20);
    await snap('02-settings-ai');
    await group.screenshot({path: path.join(artifactsDir, '02-settings-card.png'), animations: 'disabled'});
    await openProfile();
    await snap('02a-profile');
    await openPrompts();
    await promptEditor.waitFor({state: 'visible'});
    await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
    await snap('02b-prompts');
    for (const width of [820, 390]) {
      await options.setViewportSize({width, height: 900});
      await group.scrollIntoViewIfNeeded();
      const overflow = await options.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await snap(`03-settings-${width}`);
      if (width === 390) {
        await openProfile();
        await snap('03-profile-390');
        await openPrompts();
        await promptEditor.waitFor({state: 'visible'});
        const bounds = await profileEditor.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'inline input translation settings fit narrow viewport');
        await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
        await snap('03-prompts-390');
        await options.keyboard.press('Escape');
      }
    }
    await options.setViewportSize({width: 1280, height: 600});
    await openPrompts();
    await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
    await snap('03-prompts-short');
    await options.setViewportSize({width: 1280, height: 900});
    await patch({theme: 'dark'});
    await group.scrollIntoViewIfNeeded();
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await snap('04-settings-dark');
    await openProfile();
    await snap('04-profile-dark');
    await openPrompts();
    await snap('04-prompts-dark');
    await patch({theme: 'light', inputBoxTranslationInterval: 400});
    assert.equal((await readConfig()).service, 'microsoft');
    assert.deepEqual((await readConfig()).model, globalBefore.model);
    assert.deepEqual((await readConfig()).customModel, globalBefore.customModel);
    assert.equal((await readConfig()).user_role.openai, 'GLOBAL PROMPT {{origin}} {{to}}');
    report.cases.push({name: 'independent AI config, responsive layout, preserved global config', passed: true});

    await context.route('https://input-translation.example/**', route => route.fulfill({status: 200, contentType: 'text/html', body: html}));
    const page = await helper.newPageWithoutForeground(context);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto('https://input-translation.example/test');
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    report.inputEventCapabilities = await page.evaluate(() => {
      if (typeof StaticRange !== 'function' || typeof InputEvent !== 'function') return {targetRangesAvailable: false};
      const node = document.createTextNode('range');
      const range = new StaticRange({startContainer: node, startOffset: 1, endContainer: node, endOffset: 3});
      const event = new InputEvent('beforeinput', {bubbles: true, cancelable: true, inputType: 'deleteContentBackward', targetRanges: [range]});
      const targets = event.getTargetRanges();
      return {targetRangesAvailable: true, retainedCount: targets.length,
        retainedBoundary: targets[0]?.startContainer === node && targets[0]?.startOffset === 1
          && targets[0]?.endContainer === node && targets[0]?.endOffset === 3};
    });
    await helper.activateExtensionTabWithoutForeground(context, page);
    const textarea = page.locator('#message');
    const requests = () => worker.evaluate(() => globalThis.inputTest.requests);
    const requestCount = async () => (await requests()).length;
    const abortCount = () => worker.evaluate(() => globalThis.inputTest.aborted);
    const waitForRequest = count => waitForAsyncCondition(async () => await requestCount() >= count,
      {timeoutMs: 15000, message: `输入翻译供应商请求未到达 ${count} 次`});
    const waitForAbort = count => waitForAsyncCondition(async () => await abortCount() >= count,
      {timeoutMs: 5000, message: `输入翻译供应商请求未被取消 ${count} 次`});
    const mode = value => worker.evaluate(value => globalThis.inputTest.mode = value, value);
    const release = () => worker.evaluate(() => {
      globalThis.inputTest.mode = 'success';
      globalThis.inputTest.pending.splice(0).forEach(resolve => resolve());
    });
    async function triple(symbol = '=', gap = 60) {
      for (let i = 0; i < 3; i++) {await page.keyboard.press(symbol); if (i < 2) await pause(gap);}
    }
    async function expectValue(value) {
      try { await page.waitForFunction(value => document.querySelector('#message').value === value, value, {timeout: 15000}); }
      catch (error) {
        report.failedInput = {expected: value, actual: await textarea.inputValue(), active: await page.evaluate(() => document.activeElement?.id)};
        report.runtimeRequests = await requests();
        await snap('failed-input', page);
        throw error;
      }
    }
    await textarea.fill('明天下午见面。=');
    await triple();
    await expectValue('Let us meet tomorrow afternoon.');
    const first = (await requests()).at(-1);
    assert.equal(first.body.model, 'gpt-4.1-nano');
    assert.ok(JSON.stringify(first.body).includes('明天下午见面。='));
    assert.ok(JSON.stringify(first.body).includes('Keep the message polite.'));
    assert.ok(!JSON.stringify(first.body).includes('GLOBAL PROMPT'));
    report.cases.push({name: 'triple equal uses independent model and prompts, preserves original equals', passed: true});
    const domSession = await context.newCDPSession(page);
    const executionContexts = [];
    domSession.on('Runtime.executionContextCreated', event => executionContexts.push(event.context));
    await domSession.send('Runtime.enable');
    async function blockNativeCommit() {
      // 页面主世界覆盖不了扩展的隔离世界；仅在本次 FluentRead 内容脚本世界里模拟宿主拒写。
      for (const world of executionContexts.filter(world => world.auxData?.isDefault === false)) {
        const identity = await domSession.send('Runtime.evaluate', {contextId: world.id,
          expression: 'globalThis.chrome?.runtime?.id || null', returnByValue: true});
        if (identity.result.value !== extensionId) continue;
        await domSession.send('Runtime.evaluate', {contextId: world.id, expression: `(() => {
          const original = document.execCommand.bind(document);
          document.execCommand = (command, ...args) => {
            const element = document.activeElement;
            if (command === 'insertText' && element?.id === 'blocked-native') {
              element.setAttribute('data-fluent-test-native-write-rejected', 'true');
              element.setAttribute('data-fluent-test-native-write-text', args[1]);
              return true;
            }
            return original(command, ...args);
          };
        })()`});
        report.nativeRejectionFixture = {world: world.name, isolatedExtensionId: extensionId};
        return;
      }
      throw new Error(`Cannot identify FluentRead isolated world: ${JSON.stringify(executionContexts.map(({name, origin, auxData}) => ({name, origin, auxData})))}`);
    }
    const attribute = (node, name) => {
      const index = (node.attributes || []).indexOf(name);
      return index < 0 ? null : node.attributes[index + 1];
    };
    const collectNodes = (node, predicate, matches = []) => {
      if (predicate(node)) matches.push(node);
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) collectNodes(child, predicate, matches);
      return matches;
    };
    async function readInputTooltip() {
      const tree = await domSession.send('DOM.getDocument', {depth: -1, pierce: true});
      const tooltip = collectNodes(tree.root, node => attribute(node, 'id') === 'fluent-input-translation-tooltip'
        && !String(attribute(node, 'class')).split(' ').includes('hide')).at(-1);
      if (!tooltip) return null;
      let object;
      try {
        ({object} = await domSession.send('DOM.resolveNode', {backendNodeId: tooltip.backendNodeId}));
      } catch (error) {
        // loading → 结果提示在两次 CDP 读取之间替换旧节点，重读当前 tooltip 而非判成产品失败。
        if (/No node with given id found|No node found for given backend id/.test(String(error.message))) return null;
        throw error;
      }
      try {
        const result = await domSession.send('Runtime.callFunctionOn', {objectId: object.objectId,
          functionDeclaration: `function() {
            const rect = this.getBoundingClientRect();
            const style = getComputedStyle(this);
            return {text: this.textContent, className: this.className, role: this.getAttribute('role'),
              live: this.getAttribute('aria-live'), opacity: style.opacity, display: style.display,
              color: style.color, backgroundColor: style.backgroundColor,
              rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
              viewport: {width: innerWidth, height: innerHeight},
              previews: [...this.querySelectorAll('textarea')].map(preview => ({value: preview.value,
                readonly: preview.readOnly, label: preview.getAttribute('aria-label'),
                color: getComputedStyle(preview).color, backgroundColor: getComputedStyle(preview).backgroundColor})),
              buttons: [...this.querySelectorAll('button')].map(button => ({text: button.textContent, type: button.type,
                color: getComputedStyle(button).color, backgroundColor: getComputedStyle(button).backgroundColor}))};
          }`, returnByValue: true});
        return result.result.value;
      } finally {
        await domSession.send('Runtime.releaseObject', {objectId: object.objectId});
      }
    }
    function expectInputTooltipContrast(name, state) {
      const parseColor = value => {
        assert.match(value, /^rgba?\([\d.,\s]+\)$/, `computed RGB color: ${value}`);
        const channels = value.match(/[\d.]+/g).map(Number);
        return [...channels.slice(0, 3), channels[3] ?? 1];
      };
      const composite = (foreground, background) => foreground.slice(0, 3)
        .map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
      const luminance = color => color.map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      // 白背底使半透明的深色提示背景最亮，给实际白色小字提供最差对比度边界。
      const background = composite(parseColor(state.backgroundColor), [255, 255, 255]);
      const samples = [{text: 'status', color: state.color, backgroundColor: 'rgba(0, 0, 0, 0)'},
        ...state.buttons, ...state.previews];
      const ratios = samples.map(sample => {
        const foreground = parseColor(sample.color);
        assert.deepEqual(foreground, [255, 255, 255, 1], `${name}: actual status/action/preview text is white`);
        const surface = composite(parseColor(sample.backgroundColor), background);
        const foregroundLuminance = luminance(composite(foreground, surface));
        const backgroundLuminance = luminance(surface);
        const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
        assert.ok(ratio >= 4.5, `${name}: ${sample.text || sample.label || 'preview'} white text contrast ${ratio.toFixed(3)} >= 4.5`);
        return {text: sample.text || sample.label || 'preview', foreground: sample.color,
          background: sample.backgroundColor, compositedBackground: surface, ratio};
      });
      const type = ['translating', 'success', 'error'].find(value => state.className.split(' ').includes(value));
      assert.ok(type, `${name}: known tooltip state`);
      report.tooltipContrast ||= {};
      report.tooltipContrast[name] = {type, background: state.backgroundColor, ratios,
        minimumRatio: Math.min(...ratios.map(sample => sample.ratio))};
    }
    async function expectInputTooltipGeometry(name, ready = () => true) {
      let state;
      try {
        await waitForAsyncCondition(async () => {
          state = await readInputTooltip();
          if (!state || state.display === 'none' || state.opacity !== '1') return false;
          const {rect, viewport} = state;
          return rect.width > 0 && rect.height > 0 && rect.x >= 11 && rect.y >= 11
            && rect.x + rect.width <= viewport.width - 11 && rect.y + rect.height <= viewport.height - 11 && ready(state);
        }, {timeoutMs: 5000, message: `输入翻译提示未完整位于可视区域: ${name}`});
      } catch (error) {
        report.failedTooltip = {name, state, anchor: await textarea.boundingBox(), scrollY: await page.evaluate(() => scrollY)};
        await snap('failed-tooltip', page);
        throw error;
      }
      report.tooltipGeometry ||= {};
      report.tooltipGeometry[name] = state;
      expectInputTooltipContrast(name, state);
      return state;
    }
    async function clickTooltipButton(label) {
      const tree = await domSession.send('DOM.getDocument', {depth: -1, pierce: true});
      const tooltip = collectNodes(tree.root, node => attribute(node, 'id') === 'fluent-input-translation-tooltip'
        && !String(attribute(node, 'class')).split(' ').includes('hide')).at(-1);
      assert.ok(tooltip, `translation tooltip exists for ${label}`);
      const button = collectNodes(tooltip, node => node.nodeName === 'BUTTON'
        && (node.children || []).some(child => child.nodeValue === label)).at(-1);
      assert.ok(button, `translation tooltip offers ${label}`);
      const quad = (await domSession.send('DOM.getBoxModel', {nodeId: button.nodeId})).model.content;
      await page.mouse.click((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    }
    const tree = await domSession.send('DOM.getDocument', {depth: -1, pierce: true});
    const findRestore = node => {
      if (node.nodeName === 'BUTTON' && (node.children || []).some(child => child.nodeValue === '恢复原文')) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = findRestore(child); if (found) return found;
      }
    };
    const restoreNode = findRestore(tree.root);
    assert.ok(restoreNode, 'successful translation offers restore original');
    const box = await domSession.send('DOM.getBoxModel', {nodeId: restoreNode.nodeId});
    const quad = box.model.content;
    await pause(250);
    const style = await domSession.send('DOM.resolveNode', {nodeId: restoreNode.nodeId});
    const visibility = await domSession.send('Runtime.callFunctionOn', {
      objectId: style.object.objectId,
      functionDeclaration: 'function() { const parent = getComputedStyle(this.parentElement); return {opacity: parent.opacity, display: parent.display, visibility: parent.visibility}; }',
      returnByValue: true,
    });
    assert.deepEqual(visibility.result.value, {opacity: '1', display: 'block', visibility: 'visible'});
    report.successTooltipVisibility = visibility.result.value;
    await snap('05-translated-input', page);
    await page.mouse.click((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    await expectValue('明天下午见面。=');
    await textarea.focus(); await page.keyboard.press('End'); await triple();
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'restore original and translate again', passed: true});

    let before = (await requests()).length;
    await textarea.fill('间隔太慢');
    await triple('=', 550);
    await pause(500);
    assert.equal((await requests()).length, before);
    assert.equal(await textarea.inputValue(), '间隔太慢===');
    report.cases.push({name: 'slow triple does not translate', passed: true});
    await pause(450);
    await textarea.fill('这是原始消息');
    await mode('pending');
    await triple();
    await waitForRequest(before + 1);
    const editAborted = await abortCount();
    await textarea.fill('这是新编辑的消息');
    await waitForAbort(editAborted + 1);
    await release();
    await pause(600);
    assert.equal(await textarea.inputValue(), '这是新编辑的消息');
    report.cases.push({name: 'editing while pending preserves new content', passed: true});

    await mode('pending');
    await textarea.fill('失焦后仍完成翻译');
    before = await requestCount();
    await triple();
    await waitForRequest(before + 1);
    const other = page.locator('#other');
    await other.fill('在另一个输入框里继续写作。');
    const otherValue = await other.inputValue();
    await other.evaluate(element => element.setSelectionRange(2, 5));
    const focusBeforeWrite = await other.evaluate(element => ({active: document.activeElement?.id,
      value: element.value, start: element.selectionStart, end: element.selectionEnd}));
    await release();
    await expectValue('Let us meet tomorrow afternoon.');
    const focusAfterWrite = await other.evaluate(element => ({active: document.activeElement?.id,
      value: element.value, start: element.selectionStart, end: element.selectionEnd}));
    assert.deepEqual(focusAfterWrite, focusBeforeWrite, 'textarea writeback preserves the next editor focus and selection');
    assert.equal(focusAfterWrite.value, otherValue);
    report.blurTextarea = {before: focusBeforeWrite, after: focusAfterWrite};
    report.cases.push({name: 'blurred textarea completes without stealing the next editor focus or selection', passed: true});

    await mode('pending');
    await textarea.fill('取消这次翻译');
    before = await requestCount();
    await triple();
    await waitForRequest(before + 1);
    const escapeAborted = await abortCount();
    await page.keyboard.press('Escape');
    const cancelledValue = await textarea.inputValue();
    await waitForAbort(escapeAborted + 1);
    await release();
    await pause(500);
    assert.equal(await textarea.inputValue(), '取消这次翻译', 'Escape leaves no trigger symbols');
    assert.equal(await textarea.inputValue(), cancelledValue);
    report.cases.push({name: 'Escape aborts the provider request and preserves text without trigger symbols', passed: true});

    await mode('failure');
    await textarea.fill('服务失败时保留我');
    await triple();
    await pause(1500);
    assert.equal(await textarea.inputValue(), '服务失败时保留我', 'failure leaves no trigger symbols');
    const failureTooltip = await expectInputTooltipGeometry('failed-request-retry');
    assert.ok(failureTooltip.buttons.some(button => button.text === '重试'));
    await snap('06-provider-error-retry', page);
    await mode('success');
    await clickTooltipButton('重试');
    await expectValue('Let us meet tomorrow afternoon.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', 'Retry keeps the editor focused');
    assert.ok(JSON.stringify((await requests()).at(-1).body).includes('服务失败时保留我'));
    report.cases.push({name: 'failure retains clean text and an inline Retry succeeds without moving editor focus', passed: true});

    const editorText = selector => page.locator(selector).evaluate(element => element.textContent);
    async function expectEditor(selector, value) {
      try { await page.waitForFunction(({selector, value}) => document.querySelector(selector).textContent === value, {selector, value}, {timeout: 15000}); }
      catch (error) {
        report.failedEditor = {selector, expected: value, actual: await editorText(selector)};
        await snap('failed-editor', page);
        throw error;
      }
    }
    const lastSourceText = async () => JSON.stringify((await requests()).at(-1).body);

    // 聚焦编辑宿主时光标位于开头：触发符插在原文之前，同样不能进入原文。
    await page.locator('#rich').focus(); await triple();
    await expectEditor('#rich', 'Let us meet tomorrow afternoon.');
    assert.ok((await lastSourceText()).includes('这段格式需要保留。'));
    assert.ok(!(await lastSourceText()).includes('这段格式需要保留。='), 'trigger symbols are removed from rich text source');
    await snap('06-rich-editor-translated', page);
    // macOS 撤销是 Meta+Z，其他平台是 Control+Z。
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => document.querySelector('#rich').innerHTML === '<b>这段格式需要保留。</b>');
    report.cases.push({name: 'native rich editor translates via undoable native editing; undo restores bold formatting', passed: true});

    await page.locator('#model').focus(); await triple();
    await expectEditor('#model', 'Let us meet tomorrow afternoon.');
    const modelLog = await page.evaluate(() => window.modelEditorLog);
    const modelWrite = modelLog.at(-1);
    assert.deepEqual({source: modelWrite.source, start: modelWrite.start, end: modelWrite.end}, {source: 'beforeinput', start: 0, end: modelWrite.length},
      `model-driven editor receives standard whole-document input after selection sync: ${JSON.stringify(modelLog)}`);
    assert.ok((await lastSourceText()).includes('模型编辑器原文。') && !(await lastSourceText()).includes('模型编辑器原文。='));
    // 上一个编辑器的提示有 300ms 淡出动画，取 DOM 中最后挂载的恢复按钮。
    await pause(400);
    const restoreButtons = [];
    const collectRestore = node => {
      if (node.nodeName === 'BUTTON' && (node.children || []).some(child => child.nodeValue === '恢复原文')) restoreButtons.push(node);
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) collectRestore(child);
    };
    collectRestore((await domSession.send('DOM.getDocument', {depth: -1, pierce: true})).root);
    report.modelRestoreCandidates = restoreButtons.length;
    const modelRestore = restoreButtons.at(-1);
    assert.ok(modelRestore, 'rich editor translation offers restore original');
    const modelQuad = (await domSession.send('DOM.getBoxModel', {nodeId: modelRestore.nodeId})).model.content;
    await pause(250);
    await page.mouse.click((modelQuad[0] + modelQuad[4]) / 2, (modelQuad[1] + modelQuad[5]) / 2);
    await expectEditor('#model', '模型编辑器原文。');
    report.modelEditorLog = await page.evaluate(() => window.modelEditorLog);
    report.cases.push({name: 'model-driven editor gets standard whole-content input after selection sync, restore original', passed: true});

    await page.locator('#plain').focus(); await triple();
    await expectEditor('#plain', 'Let us meet tomorrow afternoon.');
    report.cases.push({name: 'plaintext-only editor supports triple trigger', passed: true});

    before = (await requests()).length;
    await page.locator('#password').focus(); await triple();
    await page.locator('#code').focus(); await triple();
    await pause(500);
    assert.equal((await requests()).length, before);
    const passwordValue = await page.locator('#password').inputValue();
    assert.equal(passwordValue.replace(/=/g, ''), 'private');
    assert.equal(passwordValue.length, 'private'.length + 3, 'all three password keys stay with the host input');
    assert.equal(await editorText('#code'), '===const a = 1;');
    report.cases.push({name: 'password and code editor excluded', passed: true});
    await snap('06-host-inputs-preserved', page);
    for (const [trigger, symbol] of [['triple_space', 'Space'], ['triple_dash', '-']]) {
      await patch({inputBoxTranslationTrigger: trigger});
      await textarea.fill('请保留原来的结尾-'); await triple(symbol);
      await expectValue('Let us meet tomorrow afternoon.');
    }
    await patch({inputBoxTranslationTrigger: 'ctrl_enter'});
    assert.ok((await options.getByTestId('input-translation-trigger').textContent()).includes('Ctrl+Enter'), 'saved legacy shortcut retains its readable label');
    await textarea.fill('普通快捷键翻译'); await page.keyboard.press('Control+Enter');
    await expectValue('Let us meet tomorrow afternoon.');
    assert.equal(await page.evaluate(() => window.pageSawCtrlEnter === true), false, 'consumed Control+Enter does not reach page send shortcuts');
    report.cases.push({name: 'Space, dash and Control+Enter triggers', passed: true});
    before = await requestCount();
    const repeatedAborts = await abortCount();
    await mode('pending');
    await textarea.fill('重复快捷键只翻译一次');
    await page.keyboard.press('Control+Enter');
    await waitForRequest(before + 1);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Enter');
    await pause(400);
    assert.equal(await requestCount(), before + 1, 'repeated pending shortcuts share exactly one provider request');
    assert.equal(await abortCount(), repeatedAborts, 'repeated pending shortcuts retain the original active request');
    assert.equal(await textarea.inputValue(), '重复快捷键只翻译一次');
    assert.equal(await page.evaluate(() => window.pageSawCtrlEnter === true), false,
      'repeated pending shortcuts do not reach the host send shortcut');
    await release();
    await expectValue('Let us meet tomorrow afternoon.');
    assert.equal(await requestCount(), before + 1, 'completion also keeps the duplicate shortcuts at one provider request');
    report.repeatedShortcut = {triggers: 5, requests: (await requestCount()) - before, passed: true};
    report.cases.push({name: 'repeated Control+Enter while pending sends one request and never submits the host editor', passed: true});

    await patch({animations: false});
    await page.locator('#rich').evaluate(element => element.innerHTML = '<b>失焦取消时保留富文本原文。</b>');
    const blurredRichOriginal = await page.locator('#rich').evaluate(element => element.innerHTML);
    before = await requestCount();
    const blurAborted = await abortCount();
    await mode('pending');
    await page.locator('#rich').focus();
    await page.keyboard.press('Control+Enter');
    await waitForRequest(before + 1);
    await other.focus();
    await other.evaluate(element => element.setSelectionRange(1, 3));
    await waitForAbort(blurAborted + 1);
    await release();
    await pause(200);
    assert.equal(await page.locator('#rich').evaluate(element => element.innerHTML), blurredRichOriginal);
    const blurredRichFocus = await other.evaluate(element => ({active: document.activeElement?.id,
      value: element.value, start: element.selectionStart, end: element.selectionEnd}));
    assert.deepEqual(blurredRichFocus, {active: 'other', value: otherValue, start: 1, end: 3});
    report.blurRich = {html: blurredRichOriginal, focus: blurredRichFocus, abortedRequests: (await abortCount()) - blurAborted};
    report.cases.push({name: 'blurred rich editor aborts the request and preserves formatting, next editor focus and selection', passed: true});

    await page.locator('#model').focus();
    await page.keyboard.press('Control+Enter');
    await expectEditor('#model', 'Let us meet tomorrow afternoon.');
    await expectInputTooltipGeometry('model-before-restore-race', state => state.buttons.some(button => button.text === '恢复原文'));
    await page.evaluate(() => {
      const root = document.getElementById('model');
      const range = document.createRange();
      range.setStart(root.firstChild, 5); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await pause(40);
    await page.evaluate(() => {window.holdModelSelection = true; window.modelSelectionHeld = false;});
    await clickTooltipButton('恢复原文');
    await page.waitForFunction(() => window.modelSelectionHeld === true, null, {timeout: 5000});
    await page.keyboard.press('x');
    const typedDuringRestore = 'Let us meet tomorrow afternoon.'.slice(0, 5) + 'x' + 'Let us meet tomorrow afternoon.'.slice(5);
    await expectEditor('#model', typedDuringRestore);
    const restoreRaceLog = await page.evaluate(() => window.modelEditorLog.at(-1));
    assert.deepEqual({source: restoreRaceLog.source, start: restoreRaceLog.start, end: restoreRaceLog.end},
      {source: 'beforeinput', start: 5, end: 5}, 'real typing during restore uses the user caret instead of the temporary whole-document selection');
    report.restoreTypingRace = {text: typedDuringRestore, edit: restoreRaceLog, passed: true};
    await snap('17-rich-restore-typing-preserved', page);
    await page.evaluate(() => {window.holdModelSelection = false; window.resetModelEditor('模型编辑器原文。');});
    report.cases.push({name: 'real typing while Restore waits for model selection sync preserves the whole draft and user caret', passed: true});

    await page.setViewportSize({width: 390, height: 600});
    await textarea.fill('窄屏与滚动时可取消的翻译');
    await textarea.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 16));
    before = await requestCount();
    const buttonAborted = await abortCount();
    await mode('pending');
    await page.keyboard.press('Control+Enter');
    await waitForRequest(before + 1);
    const narrowTooltip = await expectInputTooltipGeometry('pending-390-top-edge');
    assert.equal(narrowTooltip.role, 'status');
    assert.equal(narrowTooltip.live, 'polite');
    assert.ok(narrowTooltip.buttons.some(button => button.text === '取消' && button.type === 'button'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await snap('14-loading-tooltip-390', page);
    await page.evaluate(() => window.scrollBy(0, -80));
    const scrolledTooltip = await expectInputTooltipGeometry('pending-390-after-scroll',
      state => Math.abs(state.rect.y - narrowTooltip.rect.y) > 20);
    assert.ok(Math.abs(scrolledTooltip.rect.y - narrowTooltip.rect.y) > 20, 'the pending tooltip follows the editor after scrolling');
    await snap('15-loading-tooltip-scrolled', page);
    await page.setViewportSize({width: 820, height: 600});
    const resizedTooltip = await expectInputTooltipGeometry('pending-820-after-resize',
      state => Math.abs(state.rect.x - scrolledTooltip.rect.x) > 20);
    assert.ok(Math.abs(resizedTooltip.rect.x - scrolledTooltip.rect.x) > 20, 'the pending tooltip follows the editor after resizing');
    await snap('16-loading-tooltip-resized', page);
    await clickTooltipButton('取消');
    await waitForAbort(buttonAborted + 1);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', 'cancel button does not take focus from the editor');
    assert.equal(await textarea.inputValue(), '窄屏与滚动时可取消的翻译');
    await page.waitForFunction(() => !document.getElementById('fluent-input-translation-tooltip-host'));
    await release();
    await pause(200);
    assert.equal(await textarea.inputValue(), '窄屏与滚动时可取消的翻译');
    report.cancelButton = {abortedRequests: (await abortCount()) - buttonAborted, active: 'message', passed: true};
    report.cases.push({name: 'accessible pending tooltip follows narrow viewport, scroll and resize; Cancel aborts without losing input focus', passed: true});

    await page.setViewportSize({width: 390, height: 600});
    await blockNativeCommit();
    for (const id of ['blocked-paste', 'blocked-native']) {
      const editor = page.locator(`#${id}`);
      const originalHtml = await editor.evaluate(element => element.innerHTML);
      before = await requestCount();
      await editor.focus();
      await page.keyboard.press('Control+Enter');
      await waitForRequest(before + 1);
      const preview = await expectInputTooltipGeometry(`manual-preview-${id}-390`,
        state => state.previews.some(preview => preview.value === 'Let us meet tomorrow afternoon.'));
      assert.equal(await editor.evaluate(element => element.innerHTML), originalHtml, 'rejected automatic writing preserves original rich formatting');
      assert.deepEqual(preview.previews.map(({value, readonly, label}) => ({value, readonly, label})),
        [{value: 'Let us meet tomorrow afternoon.', readonly: true, label: '译文'}]);
      assert.ok(preview.buttons.some(button => button.text === '关闭'));
      if (id === 'blocked-native') {
        assert.equal(await editor.getAttribute('data-fluent-test-native-write-rejected'), 'true');
        assert.equal(await editor.getAttribute('data-fluent-test-native-write-text'), 'Let us meet tomorrow afternoon.');
      } else {
        await pause(8200);
        const retained = await readInputTooltip();
        assert.equal(retained?.previews?.[0]?.value, 'Let us meet tomorrow afternoon.', 'manual-copy result remains beyond the normal eight-second tooltip expiry');
      }
      await snap(`18-manual-preview-${id}-390`, page);
      await clickTooltipButton('关闭');
      await page.waitForFunction(() => !document.getElementById('fluent-input-translation-tooltip-host'));
      assert.equal(await editor.evaluate(element => element.innerHTML), originalHtml);
      report.manualPreview ||= [];
      report.manualPreview.push({editor: id, originalHtml, preview: preview.previews[0], passed: true});
    }
    report.blockedEditorLog = await page.evaluate(() => window.blockedEditorLog);
    report.cases.push({name: 'rejected controlled paste and uncommitted native insert retain original formatting and persistent narrow manual-copy previews with Close', passed: true});
    await page.setViewportSize({width: 1280, height: 900});
    await patch({inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationInterval: 1200});
    await textarea.fill('间隔设置立即生效'); await triple('=', 650);
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'interval change applies without page reload', passed: true});
    await patch({inputBoxTranslationOutputMode: 'append', animations: false});
    const bilingualOriginal = '  明天下午见面。\n请确认时间。  ';
    await textarea.fill(bilingualOriginal); await triple();
    await expectValue(`${bilingualOriginal}\nLet us meet tomorrow afternoon.`);
    await snap('07-bilingual-textarea', page);
    await pause(400);
    const bilingualRestore = findRestore((await domSession.send('DOM.getDocument', {depth: -1, pierce: true})).root);
    assert.ok(bilingualRestore);
    const restoreQuad = (await domSession.send('DOM.getBoxModel', {nodeId: bilingualRestore.nodeId})).model.content;
    await page.mouse.click((restoreQuad[0] + restoreQuad[4]) / 2, (restoreQuad[1] + restoreQuad[5]) / 2);
    await expectValue(bilingualOriginal);
    await textarea.focus(); await page.keyboard.press('End'); await triple();
    await expectValue(`${bilingualOriginal}\nLet us meet tomorrow afternoon.`);
    report.cases.push({name: 'bilingual textarea preserves whitespace and paragraphs, restores and translates again', passed: true});

    await mode('pending');
    before = await requestCount();
    const bilingualEditAborted = await abortCount();
    await textarea.fill('继续编辑时不要追加'); await triple();
    await waitForRequest(before + 1);
    await textarea.fill('新的回复');
    await waitForAbort(bilingualEditAborted + 1);
    await release(); await pause(500);
    assert.equal(await textarea.inputValue(), '新的回复');
    await mode('pending');
    before = await requestCount();
    const bilingualEscapeAborted = await abortCount();
    await textarea.fill('取消追加'); await triple();
    await waitForRequest(before + 1);
    await page.keyboard.press('Escape');
    await waitForAbort(bilingualEscapeAborted + 1);
    await release(); await pause(500);
    assert.equal(await textarea.inputValue(), '取消追加');
    await mode('failure');
    await textarea.fill('失败保留原文'); await triple(); await pause(1000);
    assert.equal(await textarea.inputValue(), '失败保留原文');
    await mode('success');
    report.cases.push({name: 'bilingual late edit, Escape and failure preserve the original without trigger symbols', passed: true});

    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<p><b>中文原文。</b><a href="https://example.test/keep">链接</a></p><p>第二段</p>';
      window.originalBold = rich.querySelector('b');
      window.originalLink = rich.querySelector('a');
    });
    const originalRichText = await page.locator('#rich').innerText();
    await page.locator('#rich').focus(); await triple();
    await page.waitForFunction(() => document.querySelector('#rich').innerText.includes('Let us meet tomorrow afternoon.'), null, {timeout: 15000});
    const richEvidence = await page.locator('#rich').evaluate(element => ({text: element.innerText, html: element.innerHTML,
      sameBold: element.querySelector('b') === window.originalBold,
      sameLink: element.querySelector('a') === window.originalLink,
      href: element.querySelector('a')?.getAttribute('href')}));
    assert.ok(richEvidence.text.startsWith(originalRichText), 'rich original keeps its existing paragraph breaks');
    assert.match(richEvidence.text.slice(originalRichText.length), /^\n+Let us meet tomorrow afternoon\.$/, 'translation is separated by the native editor paragraph boundary');
    assert.equal(richEvidence.sameBold, true); assert.equal(richEvidence.sameLink, true);
    assert.equal(richEvidence.href, 'https://example.test/keep');
    report.bilingualRich = richEvidence;
    await snap('08-bilingual-rich-formatting', page);
    report.cases.push({name: 'bilingual rich text preserves original DOM, paragraphs, bold and link; trigger removed at starting caret', passed: true});

    await page.locator('#model').focus(); await triple();
    await expectEditor('#model', '模型编辑器原文。\nLet us meet tomorrow afternoon.');
    report.cases.push({name: 'bilingual model editor removes trigger through model and appends after selection sync', passed: true});
    before = (await requests()).length;
    await page.locator('#other').fill('单行保持原文'); await triple(); await pause(500);
    assert.equal(await page.locator('#other').inputValue(), '单行保持原文');
    assert.equal((await requests()).length, before);
    report.cases.push({name: 'single-line input keeps original and avoids flattened bilingual output', passed: true});
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    await group.scrollIntoViewIfNeeded();
    await snap('09-bilingual-settings-reopened');
    await options.setViewportSize({width: 390, height: 900});
    await group.scrollIntoViewIfNeeded();
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await snap('10-bilingual-settings-390');
    await selectTestId('input-translation-output-mode', '译文在前，原文在后');
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'prepend');
    await group.scrollIntoViewIfNeeded();
    await snap('11-translation-first-settings');
    await textarea.fill(bilingualOriginal); await triple();
    await expectValue(`Let us meet tomorrow afternoon.\n${bilingualOriginal}`);
    await snap('12-translation-first-textarea', page);
    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<b>原文保持格式</b><a href="https://example.test/keep">链接</a>';
      window.originalBold = rich.querySelector('b');
      window.originalLink = rich.querySelector('a');
    });
    await page.locator('#rich').focus(); await triple();
    await page.waitForFunction(() => document.querySelector('#rich').innerText === 'Let us meet tomorrow afternoon.\n原文保持格式链接', null, {timeout: 15000});
    report.translationFirstRich = await page.locator('#rich').evaluate(element => ({text: element.innerText, html: element.innerHTML,
      boldTexts: [...element.querySelectorAll('b')].map(node => node.textContent),
      links: [...element.querySelectorAll('a')].map(node => ({text: node.textContent, href: node.getAttribute('href')}))}));
    assert.ok(report.translationFirstRich.boldTexts.includes('原文保持格式'), 'native prefix editing preserves original bold text even when the browser splits inline nodes');
    assert.deepEqual(report.translationFirstRich.links, [{text: '链接', href: 'https://example.test/keep'}]);
    await snap('13-translation-first-rich', page);
    report.cases.push({name: 'translation first persists and prefixes translation to textarea and rich editor while keeping original text and formatting', passed: true});
    await patch({inputBoxTranslationTrigger: 'triple_space'});
    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<b>空格回复</b>';
      window.originalBold = rich.querySelector('b');
    });
    await page.locator('#rich').focus(); await triple('Space');
    await page.waitForFunction(() => document.querySelector('#rich').innerText === 'Let us meet tomorrow afternoon.\n空格回复', null, {timeout: 15000});
    assert.ok(await page.locator('#rich').evaluate(element => [...element.querySelectorAll('b')].some(node => node.textContent === '空格回复')));
    report.cases.push({name: 'rich triple-space handles browser non-breaking trigger spaces without altering original formatting', passed: true});
    assert.deepEqual(report.consoleErrors, []);
    report.runtimeRequests = await requests();
    report.providerAbortCount = await abortCount();
    report.persistenceCases = report.cases.filter(item => /config|interval/.test(item.name));
    assert.deepEqual([...new Set(Object.values(report.tooltipContrast).map(sample => sample.type))].sort(),
      ['error', 'success', 'translating'], 'contrast measured for all three rendered status backgrounds');
    report.completed = true;
  } catch (error) {
    primaryError = error;
    if (captureInputFixture) {
      try {await captureInputFixture();}
      catch (diagnosticError) {report.runtimeDiagnosticError = diagnosticError.stack || String(diagnosticError);}
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {
        cleanupErrors.push(error);
        report.completed = false;
        report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
      }
    };
    let browserClosed = false;
    await cleanup(async () => {
      if (session) {await session.close(); browserClosed = true;}
    });
    await cleanup(() => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    await cleanup(() => {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}
main().catch(error => {
  report.completed = false;
  report.fatal = error.stack;
  console.error(error);
  process.exitCode = 1;
  try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
  catch (reportError) {console.error('Report write failed:', reportError);}
});
