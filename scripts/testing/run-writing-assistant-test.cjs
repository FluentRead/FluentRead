#!/usr/bin/env node
'use strict';
// 写作助手生产扩展回归：独立后台 Edge、脱敏站点结构与 loopback 流模型；不登录账号，不发送评论或邮件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const retiredPreferences = ['replyButtons', 'hotkey', 'disabledDomains'];
const assertPreferences = writing => {
  assert.equal(writing.language, 'auto');
  assert.equal(writing.length, 'auto');
  for (const key of retiredPreferences) assert(!Object.hasOwn(writing, key), `retired writing preference: ${key}`);
};
// GitHub 仅复现用户提供的评论容器结构，不保留账号、正文、动态 ID、URL 或第三方脚本。
const githubComposer = draft => `<div data-testid="comment-composer">
  <h2 id="comment-composer-heading">Add a comment</h2>
  <div class="IssueCommentComposer-module__commentBoxWrapper__fixture"><div class="CommentBox-module__commentBoxContainer__fixture">
    <slash-command-expander><fieldset aria-disabled="false"><div class="MarkdownEditor-module__container__fixture">
      <div class="MarkdownEditor-module__writeWrapper__fixture"><div class="MarkdownInput-module__inputWrapper__fixture"><span>
        <textarea id="editor" aria-labelledby="comment-composer-heading" placeholder="Use Markdown to format your comment" oninput="document.querySelector('#native-send').disabled=!this.value.trim()">${draft}</textarea>
      </span></div></div>
      <div data-testid="markdown-editor-footer"><div class="Footer-module__childrenStyling__fixture actions">
        <div class="secondary-actions"><button type="button">Close issue</button><button type="button" aria-label="Other actions">⌄</button></div>
        <button id="native-send" type="button" data-variant="primary" ${draft ? '' : 'disabled aria-disabled="true"'} onclick="window.sent=(window.sent||0)+1"><span>Comment</span></button>
        <span data-testid="save-button-tooltip" role="tooltip" aria-hidden="true">Draft required</span>
      </div></div>
    </div></fieldset></slash-command-expander>
  </div></div>
</div>`;
const gmailComposer = (id, draft, context = '') => `<div class="M9" id="${id}-conversation">
  ${context ? `<div class="a3s">${context}<span hidden>PRIVATE_HIDDEN_MAIL</span><button hidden>Delete account</button></div>` : ''}
  <div id="${id}" contenteditable="true" role="textbox" aria-label="Message Body">${draft}</div>
  <div class="actions"><div id="${id}-send" role="button" tabindex="0" data-tooltip="Send (Ctrl+Enter)" aria-label="Send (Ctrl+Enter)" onclick="window.sent=(window.sent||0)+1">Send</div></div>
</div>`;
function fixture(site, variant = '') {
  let body;
  if (site === 'github') {
    body = `<div class="js-comment-body">Thanks for your work. Could you follow up next week?<span hidden>PRIVATE_HIDDEN_GITHUB</span><button hidden>Delete account</button></div>${githubComposer(variant === 'draft' ? 'My original draft' : '')}`;
  } else if (variant === 'multiple') {
    body = gmailComposer('first-editor', 'DRAFT_THREAD_ONE', 'THREAD_ONE: Review the first proposal.') + gmailComposer('second-editor', 'DRAFT_THREAD_TWO', 'THREAD_TWO: Confirm the second meeting.');
  } else if (variant === 'new') {
    body = '<div class="a3s">PRIVATE_UNRELATED_OPEN_MAIL</div>' + gmailComposer('editor', '');
  } else if (variant === 'signature') {
    body = gmailComposer('editor', 'Thank you,<br><a href="https://example.test/signature">Synthetic signature</a>', 'Please review the proposal.');
  } else {
    body = gmailComposer('editor', 'My original draft', 'Thanks for your work. Could you follow up next week?');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${site} writing fixture</title><style>
    body{font:16px/1.7 system-ui;background:#f5f6f8;color:#334155;margin:0;padding:50px}main{margin-top:140px;box-sizing:border-box;width:min(850px,100%);background:white;padding:30px;border:1px solid #e4e7ec;border-radius:14px}
    textarea,[contenteditable]{width:100%;min-height:125px;border:1px solid #cbd5e1;border-radius:8px;padding:14px;font:inherit;box-sizing:border-box}button,[role=button]{padding:8px 18px}fieldset{border:0;margin:0;padding:0;min-width:0}.actions{display:flex;justify-content:flex-end;align-items:center;margin-top:16px;gap:0}.secondary-actions{display:flex;margin-right:auto}.M9+.M9{margin-top:30px}.js-comment-body,.a3s{padding:15px 0 25px}[role=tooltip]{display:none}[role=button]{background:#e7effd;border-radius:6px;cursor:pointer}
    @media(max-width:600px){body{padding:12px}main{padding:16px}.secondary-actions{display:none}button,[role=button]{padding:7px 10px}}
  </style></head><body><aside hidden>PRIVATE_UNRELATED_TEXT</aside><main role="main"><h1>${site === 'gmail' ? 'A thoughtful follow-up' : 'Discussing the next release'}</h1>${body}</main></body></html>`;
}
(async () => {
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-writing-browser'));
  const suite = arg('suite', 'all'); assert(['all', 'presentation'].includes(suite), '--suite must be all or presentation');
  const packages = arg('playwright-root'); const helper = arg('focus-safe-helper');
  assert(packages && helper, '--playwright-root and --focus-safe-helper are required');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const requests = []; const responsePlans = [];
  const report = {ok: false, suite, extensionDir, artifactsDir, cases: [], screenshots: [], consoleErrors: [], consoleMessages: [], cardStability: [], persistenceCases: [], quickClose: false, crossPageSync: false, latestWriteWins: false, evidenceBoundary: `${suite === 'presentation' ? 'Presentation suite only: shared initialization, settings, independent connection navigation and persistence; fresh-page global site rule, dark PR, mobile layouts, unsupported routes and popup absence. Full generation lifecycle, versions, partial errors, Gmail isolation and precise positioning are not run in this suite. ' : 'All writing regression cases are enabled. '}GitHub Issue/PR and Gmail DOM fixtures with a local synthetic streaming model. No authenticated websites, real AI output quality, physical sending, or Firefox UI are tested.`};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); const plan = responsePlans.shift() || {};
      const ordinal = requests.length + 1; requests.push({body, outcome: plan.fail ? 'failure' : plan.partialFailure ? 'partial-failure' : 'stream', ordinal});
      if (plan.fail) { res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Synthetic writing fixture failure'}})); return; }
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const actualModel = `${body.model}-actual`;
      const send = text => res.write(`data: ${JSON.stringify({id: `writing-fixture-${ordinal}`, object: 'chat.completion.chunk', created: 1, model: actualModel, choices: [{index: 0, delta: {content: text}, finish_reason: null}]})}\n\n`);
      // 不同完整正文用于证明改写与版本切换，序号保证连续结果可区分。
      send(ordinal % 2 ? `回复版本 ${ordinal}：感谢你的建议。` : `回复版本 ${ordinal}：谢谢你分享这些想法。`);
      await wait(plan.slow ? 1600 : 650);
      if (res.destroyed) return;
      if (plan.partialFailure) { res.write(`data: ${JSON.stringify({error: {message: 'Synthetic failure after partial output', type: 'server_error'}})}\n\ndata: [DONE]\n\n`); res.end(); return; }
      send(ordinal % 2 ? '我会在下周继续跟进，并及时分享进展。' : '我会整理讨论中的重点，下周再与你确认后续安排。');
      res.write(`data: ${JSON.stringify({id: `writing-fixture-${ordinal}`, object: 'chat.completion.chunk', created: 1, model: actualModel, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 20, completion_tokens: 15, total_tokens: 35}})}\n\ndata: [DONE]\n\n`); res.end();
    } catch (error) {
      if (!res.destroyed) { res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Invalid synthetic fixture request'}})); }
      report.consoleErrors.push({label: 'fixture-server', error: error.message});
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-writing-edge-'));
  let launched; let currentPage;
  try {
    const {chromium} = require(path.join(packages, 'playwright'));
    const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helper);
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), background: true, headless: false, viewport: {width: 1440, height: 1000}, timeout: 30000, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus'); assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const capture = (p, label) => { p.on('pageerror', error => report.consoleErrors.push({label, error: error.message})); p.on('console', message => { if (message.type() === 'error') report.consoleMessages.push({label, error: message.text()}); }); };
    for (const [pattern, site] of [['https://github.com/**', 'github'], ['https://mail.google.com/**', 'gmail']]) await context.route(pattern, route => route.fulfill({contentType: 'text/html', body: fixture(site, new URL(route.request().url()).searchParams.get('fixture') || '')}));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const origin = /^chrome-extension:\/\/[^/]+/.exec(worker.url())[0];
    const page = async (url, label) => { const p = await newPageWithoutForeground(context, 30000); p.setDefaultTimeout(12000); capture(p, label); await p.goto(url); currentPage = p; return p; };
    const until = async (fn, description = 'state') => { for (let index = 0; index < 150; index++) { const value = await fn(); if (value) return value; await wait(80); } throw Error(`${description} did not settle`); };
    const shot = async (p, name) => { currentPage = p; const file = path.join(artifactsDir, `${name}.png`); await p.screenshot({path: file}); report.screenshots.push(file); };
    const popup = await page(`${origin}/popup.html`, 'popup');
    const read = () => popup.evaluate(async () => { const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); if (!response.success) throw Error(response.error); return typeof response.value === 'string' ? JSON.parse(response.value) : response.value; });
    const initial = await until(async () => { const config = await read(); return config?.writing ? config : null; }, 'initial config');
    assert.equal(initial.writing.enabled, true, 'fresh configuration enables writing'); assertPreferences(initial.writing);
    report.initialPreferences = initial.writing;
    const patch = async patch => {
      const config = await read(); const keys = Object.keys(patch); const seeded = keys.includes('token');
      const response = await popup.evaluate(({patch, config, seeded}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: seeded ? 'replace' : 'patch', config: seeded ? {...config, ...patch} : patch, expected: Object.fromEntries(Object.keys(patch).map(key => [key, config[key]])), baseRevision: seeded ? config.__fluentConfigRevision : undefined, clientId: `writing-fixture-${crypto.randomUUID()}`, sequence: 1}), {patch, config, seeded});
      assert.equal(response.success, true, response.error);
      await until(async () => { const saved = await read(); return keys.filter(key => key !== 'token').every(key => JSON.stringify(saved[key]) === JSON.stringify(patch[key])); }, 'persisted patch');
    };
    await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, disableFloatingBall: true, disableSelectionTranslator: true, disableImageTranslator: true, service: 'microsoft'});
    await popup.reload(); await popup.getByRole('heading', {name: '网页翻译', exact: true}).waitFor(); assert.equal(await popup.getByText('写作助手', {exact: true}).count(), 0, 'popup has no writing entry'); await shot(popup, 'writing-popup-without-entry');
    let settings = await page(`${origin}/options.html#settings-writing`, 'settings');
    await settings.getByRole('heading', {name: '写作助手', exact: true}).waitFor();
    const assertSettings = async p => {
      const scope = p.locator('.writing-settings');
      await scope.waitFor(); await scope.getByRole('switch', {name: '启用写作助手', exact: true}).waitFor();
      assert.equal(await scope.getByRole('switch').count(), 1); assert.equal(await scope.getByRole('switch', {name: '启用写作助手', exact: true}).count(), 1);
      assert(!/使用偏好|禁用网站|写作快捷键|显示回复按钮/.test(await scope.innerText()));
      assert.equal(await scope.getByRole('combobox', {name: '输出语言', exact: true}).count(), 0);
      const icon = p.locator('button[data-section="settings-writing"] .nav-icon'); assert.equal(await icon.innerText(), '✎'); assert.equal(await icon.locator('img').count(), 0);
    };
    await assertSettings(settings); await shot(settings, 'writing-settings-light');
    // 写作连接跳转只改变服务页正在编辑的服务，不能改变网页翻译默认值。
    const unconfiguredWriting = (await read()).writing;
    await patch({writing: {...unconfiguredWriting, service: 'openai'}});
    await settings.getByText('使用已保存的服务连接。写作服务可与网页翻译分别选择。', {exact: true}).waitFor();
    await settings.getByRole('button', {name: '配置服务连接 →', exact: true}).click();
    await settings.waitForURL(`${origin}/options.html#settings-services`);
    const serviceCatalog = settings.locator('.service-catalog[data-editing-service]'); await serviceCatalog.waitFor();
    assert.equal(await serviceCatalog.getAttribute('data-editing-service'), 'openai', 'writing connection opens its independently selected service');
    assert.equal(await serviceCatalog.getAttribute('data-default-service'), 'microsoft', 'connection editing preserves default page translation service');
    assert.equal((await read()).service, 'microsoft', 'connection navigation must not persist a new default service');
    await shot(settings, 'writing-independent-service-connection');
    await patch({writing: {...unconfiguredWriting, service: '', model: ''}});
    await settings.locator('button[data-section="settings-writing"]').click(); await assertSettings(settings);
    assert.equal((await read()).service, 'microsoft'); assert.equal((await read()).writing.service, '');
    report.cases.push('writing OpenAI connection opens the OpenAI editor while Microsoft remains the persisted default page translation service');
    const firstPage = await page('https://github.com/fluentread-fixture/project/issues/1', 'default-auto-entry');
    const entry = p => p.getByRole('button', {name: '写作助手', exact: true});
    const dialog = p => p.getByRole('dialog', {name: '写作助手', exact: true});
    const output = p => p.getByRole('textbox', {name: '生成正文', exact: true});
    const instruction = p => p.getByRole('textbox', {name: '写作要求', exact: true});
    await entry(firstPage).waitFor(); assert.equal(requests.length, 0);
    await entry(firstPage).click(); await firstPage.getByRole('button', {name: '设置写作服务', exact: true}).waitFor();
    assert.match(await dialog(firstPage).innerText(), /先选择一个 AI 服务/); assert.equal(requests.length, 0);
    const priorPages = new Set(context.pages()); await firstPage.getByRole('button', {name: '设置写作服务', exact: true}).click();
    const openedSettings = await until(() => context.pages().find(p => !priorPages.has(p) && p.url() === `${origin}/options.html#settings-writing`), 'real writing settings navigation');
    capture(openedSettings, 'setup-navigation'); await openedSettings.getByRole('heading', {name: '写作助手', exact: true}).waitFor(); await shot(openedSettings, 'writing-service-setup-navigation'); await openedSettings.close();
    report.cases.push('default enabled, automatic entry, single settings switch, plain navigation icon, popup absence and unsupported machine service setup navigation');
    // 从真实设置控件关闭，立即销毁设置页，再读持久化和已打开网页的挂载状态。
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await settings.close();
    await until(async () => (await read()).writing.enabled === false, 'immediate-close disabled preference');
    await firstPage.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'});
    settings = await page(`${origin}/options.html#settings-writing`, 'settings-reopened'); await assertSettings(settings);
    assert.equal(await settings.getByRole('switch', {name: '启用写作助手', exact: true}).getAttribute('aria-checked'), 'false'); await shot(settings, 'writing-settings-disabled-reopened');
    report.persistenceCases.push({field: 'writing.enabled', before: true, after: false, closedImmediately: true, reopened: false}); report.quickClose = true; report.crossPageSync = true;
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await until(async () => (await read()).writing.enabled === true); await entry(firstPage).waitFor();
    // 连续两次真实控件修改，最终开启值必须持久化；只影响隔离 profile。
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click();
    await until(async () => (await read()).writing.enabled === true); await settings.close(); settings = await page(`${origin}/options.html#settings-writing`, 'settings-enabled-reopened');
    assert.equal(await settings.getByRole('switch', {name: '启用写作助手', exact: true}).getAttribute('aria-checked'), 'true'); report.latestWriteWins = true;
    await firstPage.close();
    await patch({service: 'openai', token: {...initial.token, openai: 'synthetic-writing-key'}, proxy: {...initial.proxy, openai: `http://127.0.0.1:${server.address().port}/v1/chat/completions`}, writing: {...(await read()).writing, service: 'openai', model: 'writing-fixture'}});
    const assertRequestCount = async (expected, description) => { await until(() => requests.length >= expected, description); assert.equal(requests.length, expected, description); };
    const complete = async p => { await p.getByRole('button', {name: '复制正文', exact: true}).waitFor(); assert.equal(await output(p).getAttribute('aria-busy'), 'false'); const text = await output(p).inputValue(); assert.match(text, /^回复版本 \d+：/); assert.match(text, /下周/); return text; };
    const requestBody = index => requests[index].body;
    const quotedData = body => { const content = body.messages.at(-1).content; return JSON.parse(content.slice(content.indexOf('{'))); };
    const oneGeneration = async (p, action, plan) => { const before = requests.length; if (plan) responsePlans.push(plan); await action(); await assertRequestCount(before + 1, 'one generation per user action'); const text = await complete(p); await wait(180); assert.equal(requests.length, before + 1, 'completed generation must not repeat'); return {text, body: requestBody(before)}; };
    const startSampling = async p => {
      await dialog(p).waitFor(); await p.locator('.writing-panel').evaluate(async element => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.writingSamples = []; window.sampleWriting = true; const sample = () => { if (!window.sampleWriting) return; const rect = element.getBoundingClientRect(); window.writingSamples.push({x: rect.x, y: rect.y, width: rect.width, height: rect.height}); requestAnimationFrame(sample); }; sample(); });
    };
    const endSampling = async (p, site) => { const samples = await p.evaluate(() => { window.sampleWriting = false; return window.writingSamples; }); assert(samples.length >= 5, 'streaming must include multiple visible frames'); const deltas = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.max(...samples.map(rect => rect[key])) - Math.min(...samples.map(rect => rect[key]))])); assert(Object.values(deltas).every(delta => delta === 0), `zero streaming jitter: ${JSON.stringify(deltas)}`); report.cardStability.push({site, sampleCount: samples.length, deltas}); };
    if (suite === 'all') {
    for (const site of ['github', 'gmail']) {
      const p = await page(site === 'github' ? 'https://github.com/fluentread-fixture/project/issues/2' : 'https://mail.google.com/mail/u/0/#inbox/fixture', site); currentPage = p;
      await activateExtensionTabWithoutForeground(context, p, {timeout: 12000}); await entry(p).waitFor();
      const host = p.locator('[data-fluent-read-ui="writing-entry"]');
      const native = p.locator(site === 'github' ? '#native-send' : '#editor-send');
      if (site === 'github') { assert.equal(await p.locator('#editor').getAttribute('name'), null); assert.equal(await native.getAttribute('type'), 'button'); assert.equal(await native.isDisabled(), true); assert.equal(await native.getAttribute('data-variant'), 'primary'); }
      assert.equal(await native.evaluate((element, side) => element[side]?.getAttribute('data-fluent-read-ui'), site === 'github' ? 'previousElementSibling' : 'nextElementSibling'), 'writing-entry');
      const hostBox = await host.boundingBox(); const nativeBox = await native.boundingBox();
      const gap = site === 'github' ? nativeBox.x - hostBox.x - hostBox.width : hostBox.x - nativeBox.x - nativeBox.width;
      assert(gap >= 0 && gap <= 12, `${site} entry is adjacent to native action`); assert(Math.abs(hostBox.y + hostBox.height / 2 - nativeBox.y - nativeBox.height / 2) < 5);
      assert(await host.locator('img').evaluate(image => image.complete && image.naturalWidth === 128 && image.src.endsWith('/icon/128.png')));
      const firstIndex = requests.length; responsePlans.push({slow: true}); await entry(p).click(); await startSampling(p); await assertRequestCount(firstIndex + 1, `${site} automatic initial request`);
      const firstText = await complete(p); await endSampling(p, site); await wait(200); assert.equal(requests.length, firstIndex + 1);
      assert(await p.locator('.writing-mark').evaluate(image => image.complete && image.naturalWidth === 128));
      const initialData = quotedData(requestBody(firstIndex)); assert.equal(initialData.draft, site === 'github' ? '' : 'My original draft'); assert.match(initialData.context, /follow up/);
      assert.match(requestBody(firstIndex).messages[0].content, site === 'github' ? /起草回复/ : /润色现有草稿/);
      await p.getByRole('button', {name: '参考内容', exact: true}).click();
      if (site === 'gmail') { assert.equal(await p.getByRole('textbox', {name: '写作草稿', exact: true}).inputValue(), 'My original draft'); assert.equal(await p.getByRole('textbox', {name: '写作草稿', exact: true}).isEditable(), false, 'original draft is a read-only reference'); }
      assert.match(await p.getByRole('textbox', {name: '写作参考内容', exact: true}).inputValue(), /follow up/); assert.equal(await p.getByRole('textbox', {name: '写作参考内容', exact: true}).isEditable(), true, 'discussion reference remains editable'); await p.getByRole('button', {name: '返回草稿', exact: true}).click();
      await shot(p, `${site}-automatic-writing-result`);
      // 参数调整只改写当前正文，并且不消费尚未提交的临时要求。
      await instruction(p).fill('ONE_SHOT_IMPROVEMENT');
      const languageResult = await oneGeneration(p, () => p.getByRole('combobox', {name: '输出语言', exact: true}).selectOption('en'));
      assert.equal(quotedData(languageResult.body).draft, firstText); assert.match(languageResult.body.messages[0].content, /输出语言：英语/); assert(!languageResult.body.messages.at(-1).content.includes('ONE_SHOT_IMPROVEMENT')); assert.equal(await instruction(p).inputValue(), 'ONE_SHOT_IMPROVEMENT');
      await p.getByRole('button', {name: '上一版', exact: true}).click(); assert.equal(await output(p).inputValue(), firstText); await p.getByRole('button', {name: '下一版', exact: true}).click(); assert.equal(await output(p).inputValue(), languageResult.text);
      const lengthResult = await oneGeneration(p, () => p.getByRole('combobox', {name: '回复篇幅', exact: true}).selectOption('short'));
      assert.equal(quotedData(lengthResult.body).draft, languageResult.text); assert.match(lengthResult.body.messages[0].content, /篇幅：简短/);
      const toneResult = await oneGeneration(p, () => p.getByRole('combobox', {name: '表达语气', exact: true}).selectOption('friendly'));
      assert.equal(quotedData(toneResult.body).draft, lengthResult.text); assert.match(toneResult.body.messages[0].content, /语气：友好/);
      const improved = await oneGeneration(p, () => p.getByRole('button', {name: '改进草稿', exact: true}).click());
      assert.equal(quotedData(improved.body).draft, toneResult.text); assert(improved.body.messages.at(-1).content.includes('ONE_SHOT_IMPROVEMENT')); assert.equal(await instruction(p).inputValue(), '');
      assert.notEqual(firstText, improved.text);
      const beforeFailure = requests.length; responsePlans.push({fail: true}); await instruction(p).fill('Keep the previous draft if this fails'); await p.getByRole('button', {name: '改进草稿', exact: true}).click(); await assertRequestCount(beforeFailure + 1, 'single failed request'); await p.getByRole('alert').waitFor();
      assert.equal(await output(p).inputValue(), improved.text); assert.equal(await instruction(p).inputValue(), 'Keep the previous draft if this fails');
      const retried = await oneGeneration(p, () => p.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(quotedData(retried.body).draft, improved.text); assert.equal(await instruction(p).inputValue(), '');
      const beforeStop = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeStop + 1, 'slow rewrite starts'); await until(async () => (await output(p).inputValue()) !== retried.text, 'partial rewrite'); await p.getByRole('button', {name: '停止', exact: true}).click();
      assert.equal(await output(p).inputValue(), retried.text); assert.match(await p.getByRole('status').innerText(), /已保留/); await wait(1800); assert.equal(await output(p).inputValue(), retried.text); assert.equal(requests.length, beforeStop + 1);
      await p.getByRole('button', {name: '插入回复', exact: true}).click(); await dialog(p).waitFor({state: 'hidden'});
      assert.equal(await p.locator('#editor').evaluate(element => element.value ?? element.innerText), retried.text); assert.equal(await p.evaluate(() => document.activeElement?.id), 'editor'); assert.equal(await p.evaluate(() => window.sent || 0), 0);
      const beforeReopen = requests.length; await entry(p).click(); await dialog(p).waitFor(); assert.equal(await output(p).inputValue(), retried.text); await wait(850); assert.equal(requests.length, beforeReopen, 'same editor reopens existing session');
      const staleIndex = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(staleIndex + 1, 'stale draft generation');
      await p.locator('#editor').evaluate(element => { if ('value' in element) element.value = 'New user draft'; else element.textContent = 'New user draft'; element.dispatchEvent(new Event('input', {bubbles: true})); });
      await complete(p); await p.getByRole('button', {name: '插入回复', exact: true}).click(); assert.match(await p.getByRole('alert').innerText(), /已被修改/); assert.equal(await p.locator('#editor').evaluate(element => element.value ?? element.innerText), 'New user draft');
      await p.getByRole('button', {name: '关闭写作助手', exact: true}).click(); const beforeShortcut = requests.length;
      for (const key of ['Alt+W', 'Alt+Shift+J']) { await p.locator('#editor').focus(); await p.keyboard.press(key); await wait(180); assert.equal(await dialog(p).isVisible(), false, `${key} has no writing shortcut`); } assert.equal(requests.length, beforeShortcut);
      await oneGeneration(p, () => entry(p).click());
      const beforeRoute = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeRoute + 1, 'route-owned request');
      await p.evaluate(() => history.pushState({}, '', location.pathname + '?route=changed' + (location.hash ? '#inbox/changed' : ''))); await dialog(p).waitFor({state: 'hidden'}); await wait(1800); assert.equal(await dialog(p).isVisible(), false); assert.equal(requests.length, beforeRoute + 1); assert.equal(await p.evaluate(() => window.sent || 0), 0);
      report.cases.push(`${site}: native action order, automatic draft exactly once, bounded reference, zero frame jitter, language/length/tone rewrite, one-shot improvement, versions, failure/retry, stop preservation, insertion closes and focuses without send, reopen reuse, stale protection, no shortcut and SPA cancellation`); await p.close();
    }
    // 草稿来源标签属于已生成的版本，不能被之后选择的模型或失败请求覆盖。
    const originalWriting = (await read()).writing;
    await patch({writing: {...originalWriting, model: 'writing-fixture-a'}});
    const modelPage = await page('https://github.com/fluentread-fixture/project/issues/20', 'writing-model-ownership');
    const modelA = await oneGeneration(modelPage, () => entry(modelPage).click());
    const modelLabel = () => modelPage.locator('.writing-provider small').innerText();
    assert.equal(modelA.body.model, 'writing-fixture-a'); assert.equal(await modelLabel(), 'writing-fixture-a-actual');
    const beforeModelChange = requests.length; await patch({writing: {...originalWriting, model: 'writing-fixture-b'}}); await wait(250);
    assert.equal(await output(modelPage).inputValue(), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual'); assert.equal(requests.length, beforeModelChange);
    responsePlans.push({fail: true}); await modelPage.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeModelChange + 1, 'new model failed rewrite'); await modelPage.getByRole('alert').waitFor();
    assert.equal(requestBody(beforeModelChange).model, 'writing-fixture-b'); assert.equal(await output(modelPage).inputValue(), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual');
    const modelB = await oneGeneration(modelPage, () => modelPage.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(modelB.body.model, 'writing-fixture-b'); assert.equal(quotedData(modelB.body).draft, modelA.text); assert.equal(await modelLabel(), 'writing-fixture-b-actual');
    await modelPage.getByRole('button', {name: '上一版', exact: true}).click(); assert.equal(await output(modelPage).inputValue(), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual'); await shot(modelPage, 'writing-model-a-version');
    await modelPage.getByRole('button', {name: '下一版', exact: true}).click(); assert.equal(await output(modelPage).inputValue(), modelB.text); assert.equal(await modelLabel(), 'writing-fixture-b-actual'); await shot(modelPage, 'writing-model-b-version'); await modelPage.close(); await patch({writing: originalWriting});
    report.cases.push('model metadata follows draft ownership across configuration change, failed rewrite and previous/next version selection');
    const partialPage = await page('https://github.com/fluentread-fixture/project/issues/21', 'writing-partial-stream-failure');
    const beforePartialFailure = requests.length; responsePlans.push({partialFailure: true, slow: true}); await entry(partialPage).click(); await assertRequestCount(beforePartialFailure + 1, 'first generation partial failure');
    const partialText = await until(async () => { const text = await output(partialPage).inputValue(); return text && await output(partialPage).getAttribute('aria-busy') === 'true' ? text : null; }, 'partial text before stream error');
    await partialPage.getByRole('alert').waitFor(); assert.equal(await output(partialPage).inputValue(), partialText); assert.equal(await output(partialPage).isEditable(), true); assert.equal(await output(partialPage).getAttribute('aria-busy'), 'false');
    const editedPartial = `${partialText} Manual continuation after the interrupted response.`; await output(partialPage).fill(editedPartial); await shot(partialPage, 'writing-first-stream-error-retained');
    const partialRecovery = await oneGeneration(partialPage, () => partialPage.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(quotedData(partialRecovery.body).draft, editedPartial); assert.equal(await partialPage.evaluate(() => window.sent || 0), 0); await partialPage.close();
    report.cases.push('first stream error preserves received text as an editable draft and retry uses the manually continued partial draft');
    // 初始下方展开；移动后上方也有空间，卡片仍须保持本次打开的展开方向。
    const layoutPage = await page('https://github.com/fluentread-fixture/project/issues/22?fixture=draft', 'writing-layout-follow');
    await layoutPage.setViewportSize({width: 1440, height: 1100});
    const measuredLayoutViewport = await layoutPage.evaluate(() => ({width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height ?? innerHeight, visualTop: visualViewport?.offsetTop ?? 0}));
    assert.equal(measuredLayoutViewport.width, 1440); assert.equal(measuredLayoutViewport.height, 1100, 'layout fixture uses measured content height, not outer browser window height');
    report.layoutFollow = {requestedViewport: {width: 1440, height: 1100}, measuredViewport: measuredLayoutViewport}; await entry(layoutPage).waitFor();
    await layoutPage.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; document.body.style.overflowAnchor = 'none'; document.body.style.minHeight = '1800px'; window.scrollTo(0, 0); const main = document.querySelector('main'); const host = document.querySelector('[data-fluent-read-ui="writing-entry"]'); main.style.marginTop = `${parseFloat(getComputedStyle(main).marginTop) + 390 - host.getBoundingClientRect().top}px`; });
    await oneGeneration(layoutPage, () => entry(layoutPage).click());
    const layout = async () => ({anchor: await layoutPage.locator('[data-fluent-read-ui="writing-entry"]').boundingBox(), card: await layoutPage.locator('.writing-panel').boundingBox()});
    const initialLayout = await layout(); report.layoutFollow.initial = initialLayout; assert(Math.abs(initialLayout.anchor.y - 390) < 1);
    const safeTop = measuredLayoutViewport.visualTop + 12; const safeBottom = measuredLayoutViewport.visualTop + measuredLayoutViewport.visualHeight - 12;
    assert(initialLayout.anchor.y - initialLayout.card.height - 8 < safeTop, 'fixture initially has insufficient room above');
    assert(initialLayout.anchor.y + 80 - initialLayout.card.height - 8 >= safeTop, 'resizing makes room above so a direction change would be observable');
    assert(initialLayout.anchor.y + 80 + 24 + initialLayout.anchor.height + 8 + initialLayout.card.height <= safeBottom, 'all fixture movements fit below without viewport clamping');
    assert(Math.abs(initialLayout.card.y - initialLayout.anchor.y - initialLayout.anchor.height - 8) < 1, 'initial layout opens below');
    const assertFollow = async (previous, movement, label) => {
      const current = await until(async () => { const value = await layout(); return Math.abs(value.anchor.y - previous.anchor.y - movement) < 1 && Math.abs(value.card.y - value.anchor.y - value.anchor.height - 8) < 1 ? value : null; }, label);
      assert(Math.abs(current.card.y - previous.card.y - movement) < 1, label); assert.equal(current.card.width, initialLayout.card.width); assert.equal(current.card.height, initialLayout.card.height); return current;
    };
    await layoutPage.locator('#editor').evaluate(element => { element.style.height = `${element.getBoundingClientRect().height + 80}px`; }); const resizedLayout = await assertFollow(initialLayout, 80, 'editor resizing follows without flipping above'); report.layoutFollow.resized = resizedLayout;
    await layoutPage.locator('[data-testid="comment-composer"]').evaluate(element => { const spacer = document.createElement('div'); spacer.style.height = '24px'; spacer.setAttribute('aria-hidden', 'true'); element.before(spacer); }); const shiftedLayout = await assertFollow(resizedLayout, 24, 'preceding DOM insertion follows without changing direction');
    report.layoutFollow.insertedBefore = shiftedLayout; await shot(layoutPage, 'writing-layout-follows-fixed-direction'); await layoutPage.close(); report.cases.push('editor resize and preceding DOM insertion move the card with its anchor while preserving the opening direction');
    const newMail = await page('https://mail.google.com/mail/u/0/?fixture=new#compose', 'new-mail');
    await entry(newMail).waitFor(); const beforeNew = requests.length; await entry(newMail).click(); await dialog(newMail).waitFor(); await wait(850);
    assert.equal(requests.length, beforeNew); assert.match(await dialog(newMail).innerText(), /写下回复要点/); assert.equal(await output(newMail).count(), 0); assert.equal(await newMail.getByRole('button', {name: '生成回复', exact: true}).isDisabled(), true);
    await instruction(newMail).fill('Invite the team to a short discussion.'); const composed = await oneGeneration(newMail, () => newMail.getByRole('button', {name: '生成回复', exact: true}).click()); assert.deepEqual(quotedData(composed.body), {draft: '', context: ''}); await shot(newMail, 'new-mail-from-points'); await newMail.close();
    const multiple = await page('https://mail.google.com/mail/u/0/?fixture=multiple#inbox', 'gmail-isolated-conversations'); await until(async () => (await entry(multiple).count()) === 2);
    for (const [id, own, other] of [['first-editor', 'ONE', 'TWO'], ['second-editor', 'TWO', 'ONE']]) {
      const generated = await oneGeneration(multiple, () => multiple.locator(`#${id}-conversation`).getByRole('button', {name: '写作助手', exact: true}).click()); const data = quotedData(generated.body);
      assert.equal(data.draft, `DRAFT_THREAD_${own}`); assert(data.context.includes(`THREAD_${own}`)); assert(!data.context.includes(`THREAD_${other}`)); await multiple.getByRole('button', {name: '关闭写作助手', exact: true}).click();
    }
    await multiple.close(); report.cases.push('new compose waits for points and excludes background mail; multiple Gmail drafts use only their own conversations');
    const signature = await page('https://mail.google.com/mail/u/0/?fixture=signature#inbox', 'gmail-complex-signature'); await activateExtensionTabWithoutForeground(context, signature, {timeout: 12000});
    const signatureHtml = await signature.locator('#editor').innerHTML(); const copied = await oneGeneration(signature, () => entry(signature).click()); assert.equal(await signature.getByRole('button', {name: '插入回复', exact: true}).count(), 0); assert.match(await dialog(signature).innerText(), /原草稿含格式/);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: 'https://mail.google.com'}); await signature.getByRole('button', {name: '复制回复', exact: true}).click(); await signature.getByRole('status').waitFor(); assert.match(await signature.getByRole('status').innerText(), /正文已复制/); assert.equal(await signature.evaluate(() => navigator.clipboard.readText()), copied.text);
    assert.equal(await signature.locator('#editor').innerHTML(), signatureHtml); assert.equal(await signature.evaluate(() => window.sent || 0), 0); await shot(signature, 'gmail-complex-signature-copy'); await signature.close(); report.cases.push('complex rich-text signature provides copy as primary action and preserves original HTML without sending');
    const dynamic = await page('https://github.com/fluentread-fixture/project/issues/9?fixture=draft', 'dynamic'); await oneGeneration(dynamic, () => entry(dynamic).click());
    const beforeRemoval = requests.length; responsePlans.push({slow: true}); await dynamic.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeRemoval + 1, 'removal-owned request'); await dynamic.locator('#editor').evaluate(element => element.replaceWith(element.cloneNode(true))); await dialog(dynamic).waitFor({state: 'hidden'}); await until(async () => (await entry(dynamic).count()) === 1); await wait(1800); assert.equal(requests.length, beforeRemoval + 1);
    const remounted = await oneGeneration(dynamic, () => entry(dynamic).click()); assert.equal(quotedData(remounted.body).draft, 'My original draft');
    const beforeDisable = requests.length; responsePlans.push({slow: true}); await dynamic.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeDisable + 1, 'disable-owned request'); const enabled = (await read()).writing;
    await patch({writing: {...enabled, enabled: false}}); await dynamic.locator('#fluent-read-writing-assistant').waitFor({state: 'detached'}); await dynamic.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'}); await wait(1800); assert.equal(requests.length, beforeDisable + 1);
    await patch({writing: {...enabled, enabled: true}}); await entry(dynamic).waitFor(); await oneGeneration(dynamic, () => entry(dynamic).click());
    await dynamic.getByRole('button', {name: '关闭写作助手', exact: true}).click();
    await patch({writing: {...enabled, enabled: false}}); await dynamic.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'});
    await dynamic.evaluate(() => { const input = document.createElement('input'); input.id = 'other-user-input'; input.setAttribute('aria-label', 'Other user input'); document.body.prepend(input); input.focus(); const change = document.createElement('p'); change.textContent = 'Unrelated page mutation'; document.body.append(change); });
    await wait(180); assert.equal(await dynamic.evaluate(() => document.activeElement?.id), 'other-user-input', 'disabled writing must not steal focus after a DOM mutation');
    await patch({writing: {...enabled, enabled: true}}); await entry(dynamic).waitFor(); await oneGeneration(dynamic, () => entry(dynamic).click()); await dynamic.getByRole('button', {name: '关闭写作助手', exact: true}).click();
    await dynamic.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; document.body.style.overflowAnchor = 'none'; document.body.style.minHeight = '2300px'; });
    // 先把入口放进视口并留足上方空间，避免点击自动滚动或边界钳制干扰精确位移断言。
    await dynamic.evaluate(() => { const main = document.querySelector('main'); const host = document.querySelector('[data-fluent-read-ui="writing-entry"]'); main.style.marginTop = `${parseFloat(getComputedStyle(main).marginTop) + 650 - host.getBoundingClientRect().top}px`; });
    await entry(dynamic).click(); await dialog(dynamic).waitFor(); await wait(250);
    const beforeScroll = {card: await dynamic.locator('.writing-panel').boundingBox(), anchor: await dynamic.locator('[data-fluent-read-ui="writing-entry"]').boundingBox(), y: await dynamic.evaluate(() => scrollY)};
    assert(Math.abs(beforeScroll.anchor.y - 650) < 1); assert(beforeScroll.card.y > 72, 'scroll test starts clear of the viewport edge');
    await dynamic.evaluate(() => window.scrollBy(0, 60)); await wait(250);
    const afterScroll = {card: await dynamic.locator('.writing-panel').boundingBox(), anchor: await dynamic.locator('[data-fluent-read-ui="writing-entry"]').boundingBox(), y: await dynamic.evaluate(() => scrollY)};
    assert.equal(afterScroll.y - beforeScroll.y, 60); assert(Math.abs(beforeScroll.anchor.y - afterScroll.anchor.y - 60) < 1); assert(Math.abs(beforeScroll.card.y - afterScroll.card.y - 60) < 1, 'card follows anchor while host scrolls'); report.scrollFollow = {before: beforeScroll, after: afterScroll}; await shot(dynamic, 'writing-anchored-scroll');
    await patch({disabledExtensionDomains: ['github.com']}); await dynamic.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'}); const excluded = await page('https://github.com/fluentread-fixture/project/pull/2', 'global-site-rule'); await wait(500); assert.equal(await excluded.locator('#fluent-read-writing-assistant').count(), 0); await excluded.close(); await patch({disabledExtensionDomains: []}); await entry(dynamic).waitFor(); await dynamic.close();
    report.cases.push('editor remount cancellation, one replacement entry, disable cancels stream, disabled observer cannot steal another input focus, re-enable automatic injection, anchored scrolling and existing global website rule');
    }
    if (suite === 'presentation') {
      await patch({disabledExtensionDomains: ['github.com']});
      const excluded = await page('https://github.com/fluentread-fixture/project/pull/2', 'presentation-global-site-rule'); await wait(500);
      assert.equal(await excluded.locator('#fluent-read-writing-assistant').count(), 0); assert.equal(await excluded.locator('[data-fluent-read-ui="writing-entry"]').count(), 0);
      await shot(excluded, 'writing-global-site-disabled-fresh-page');
      await patch({disabledExtensionDomains: []}); await entry(excluded).waitFor(); assert.equal(await entry(excluded).count(), 1);
      await shot(excluded, 'writing-global-site-rule-cleared'); await excluded.close();
      report.cases.push('presentation: global website rule blocks a fresh GitHub PR and clearing it automatically injects one writing entry');
    }
    await patch({theme: 'dark'}); await settings.reload(); await assertSettings(settings); await shot(settings, 'writing-settings-dark');
    const dark = await page('https://github.com/fluentread-fixture/project/pull/3', 'dark-pr'); await oneGeneration(dark, () => entry(dark).click()); assert.equal(await dark.locator('.writing-panel.is-dark').count(), 1); assert.equal(await dark.locator('[data-fluent-read-ui="writing-entry"]').getAttribute('data-theme'), 'dark'); await shot(dark, 'writing-panel-dark');
    await dark.setViewportSize({width: 390, height: 844}); await wait(250); const mobileBox = await dark.locator('.writing-panel').boundingBox(); assert(mobileBox.x >= 12 && mobileBox.x + mobileBox.width <= 378 && mobileBox.y >= 12 && mobileBox.y + mobileBox.height <= 832); assert.equal(await dark.locator('.writing-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true); await shot(dark, 'writing-panel-mobile');
    for (const name of ['输出语言', '回复篇幅', '表达语气']) assert(await dark.getByRole('combobox', {name, exact: true}).isVisible());
    await settings.setViewportSize({width: 390, height: 844}); await shot(settings, 'writing-settings-mobile'); assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const url of ['https://github.com/fluentread-fixture/project', 'https://github.com/fluentread-fixture/project/discussions/1', 'https://mail.google.com/settings']) { const unsupported = await page(url, 'unsupported-route'); await wait(450); assert.equal(await unsupported.locator('[data-fluent-read-ui="writing-entry"]').count(), 0); await unsupported.close(); }
    await popup.reload(); await popup.getByRole('heading', {name: '网页翻译', exact: true}).waitFor(); assert.equal(await popup.getByText('写作助手', {exact: true}).count(), 0); assertPreferences((await read()).writing); report.cases.push('dark Issue/PR surface, 390px panel and settings without horizontal overflow, unsupported routes absent and retired preferences remain absent');
    report.requests = requests.map(({body, ordinal, outcome}) => ({ordinal, outcome, model: body.model, messages: body.messages, stream: body.stream}));
    assert(report.requests.every(body => body.stream === true && !JSON.stringify(body.messages).includes('PRIVATE_'))); assert.equal(responsePlans.length, 0, 'all planned fixture outcomes were consumed'); assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors)); report.ok = true;
  } catch (error) {
    report.error = error.stack;
    try { if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({path: path.join(artifactsDir, 'failure.png')}); } catch {}
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(profileDir, {recursive: true, force: true});
    console.log(JSON.stringify({ok: report.ok, suite: report.suite, cases: report.cases, artifactsDir, evidenceBoundary: report.evidenceBoundary, error: report.error}));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
