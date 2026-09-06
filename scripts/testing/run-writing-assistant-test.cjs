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
  assert.equal(writing.language, 'target');
  assert.equal(writing.length, 'short');
  assert.equal(writing.style, 'auto'); assert.equal(writing.tone, 'natural'); assert.equal(writing.role, 'auto');
  for (const key of retiredPreferences) assert(!Object.hasOwn(writing, key), `retired writing preference: ${key}`);
};
const defaultExpression = {language: 'target', length: 'short', style: 'auto', tone: 'natural', role: 'auto'};
const markdownReply = '**重复翻译**需要结合触发步骤排查。\n\n- 请提供 `FluentRead` 版本。\n- 请确认是否开启自动翻译。\n\n```text\noriginal -> translated\n```\n\n参考 [项目页面](https://example.test/reproduction)。';
const plainReply = '重复翻译需要结合触发步骤排查。\n\n• 请提供 FluentRead 版本。\n• 请确认是否开启自动翻译。\n\noriginal -> translated\n\n参考 项目页面 (https://example.test/reproduction)。';
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
  if (site === 'github' && variant === 'issue421') {
    // 公开问题 #421 的最小语义结构：重复翻译标题、截图和无关项目链接；不复制用户身份或截图内容。
    body = `<span data-testid="header-state">Open</span><article data-testid="issue-body"><div data-testid="markdown-body"><img alt="Synthetic screenshot placeholder" width="80" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='40'%3E%3Crect width='80' height='40' fill='%23ddd'/%3E%3C/svg%3E"><p><a href="https://github.com/planetscale/vtprotobuf">https://github.com/planetscale/vtprotobuf</a></p></div></article>${githubComposer('')}`;
  } else if (site === 'github') {
    body = `<div class="js-comment-body">Thanks for your work. Could you follow up next week?<span hidden>PRIVATE_HIDDEN_GITHUB</span><button hidden>Delete account</button></div>${githubComposer(variant === 'draft' ? 'My original draft' : '')}`;
  } else if (variant === 'multiple') {
    body = gmailComposer('first-editor', 'DRAFT_THREAD_ONE', 'THREAD_ONE: Review the first proposal.') + gmailComposer('second-editor', 'DRAFT_THREAD_TWO', 'THREAD_TWO: Confirm the second meeting.');
  } else if (variant === 'new') {
    body = '<div class="a3s">PRIVATE_UNRELATED_OPEN_MAIL</div>' + gmailComposer('editor', '');
  } else if (variant === 'subject') {
    body = gmailComposer('editor', '').replace('<div id="editor"', '<input name="subjectbox" value="Project check-in"><div id="editor"');
  } else if (variant === 'signature') {
    body = gmailComposer('editor', 'Thank you,<br><a href="https://example.test/signature">Synthetic signature</a>', 'Please review the proposal.');
  } else {
    body = gmailComposer('editor', 'My original draft', 'Thanks for your work. Could you follow up next week?');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${site} writing fixture</title><style>
    body{font:16px/1.7 system-ui;background:#f5f6f8;color:#334155;margin:0;padding:50px}main{margin-top:140px;box-sizing:border-box;width:min(850px,100%);background:white;padding:30px;border:1px solid #e4e7ec;border-radius:14px}
    textarea,[contenteditable]{width:100%;min-height:125px;border:1px solid #cbd5e1;border-radius:8px;padding:14px;font:inherit;box-sizing:border-box}button,[role=button]{padding:8px 18px}fieldset{border:0;margin:0;padding:0;min-width:0}.actions{display:flex;justify-content:flex-end;align-items:center;margin-top:16px;gap:0}.secondary-actions{display:flex;margin-right:auto}.M9+.M9{margin-top:30px}.js-comment-body,.a3s{padding:15px 0 25px}[role=tooltip]{display:none}[role=button]{background:#e7effd;border-radius:6px;cursor:pointer}
    @media(max-width:600px){body{padding:12px}main{padding:16px}.secondary-actions{display:none}button,[role=button]{padding:7px 10px}}
  </style></head><body><aside hidden>PRIVATE_UNRELATED_TEXT</aside><main role="main"><h1 ${site === 'github' ? 'data-testid="issue-title"' : ''}>${variant === 'issue421' ? '同一段话出现了两次翻译' : site === 'gmail' ? 'A thoughtful follow-up' : 'Discussing the next release'}</h1>${body}</main></body></html>`;
}
(async () => {
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-writing-browser'));
  const suites = {all: 'All writing regression cases', settings: 'Default writing preferences, custom input stability, persistence and open-card synchronization', github: 'GitHub writing lifecycle and staged preferences', gmail: 'Gmail writing lifecycle and staged preferences', recovery: 'Model ownership and partial-stream recovery', context: 'Issue #421 context, target-language ownership, staged style, Markdown editing and insertion', compose: 'Empty and subject-only new mail, Gmail conversation isolation and rich signatures', layout: 'Editor resize and preceding-DOM positioning', dynamic: 'Remount, disabled focus, scrolling and global website rule', presentation: 'Fresh-page global website rule, dark PR, mobile layouts and unsupported routes'};
  const suite = arg('suite', 'all'); assert(Object.hasOwn(suites, suite), `--suite must be one of ${Object.keys(suites).join(', ')}`);
  const runs = name => suite === 'all' || suite === name;
  const packages = arg('playwright-root'); const helper = arg('focus-safe-helper');
  assert(packages && helper, '--playwright-root and --focus-safe-helper are required');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const requests = []; const responsePlans = [];
  const report = {ok: false, suite, extensionDir, artifactsDir, cases: [], screenshots: [], consoleErrors: [], consoleMessages: [], cardStability: [], persistenceCases: [], tabClosures: [], quickClose: false, crossPageSync: false, latestWriteWins: false, evidenceBoundary: `${suites[suite]} enabled, plus shared initialization, settings, independent connection navigation, persistence and popup absence. ${suite === 'all' ? '' : 'Only this named suite ran; other writing regression suites are not covered by this report. '}GitHub Issue/PR and Gmail DOM fixtures with a local synthetic streaming model. Issue #421 uses its reported title and body-link structure with a synthetic screenshot placeholder; payload checks prove context and prompt assembly, not real AI reply quality. Quick-close cases do not wait for persistence, but first activate the resident extension tab through the focus-safe helper before closing the test page. No authenticated websites, physical sending, or Firefox UI are tested.`};
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
      const reply = plan.markdown ? markdownReply : null;
      send(reply ? reply.slice(0, 30) : ordinal % 2 ? `回复版本 ${ordinal}：感谢你的建议。` : `回复版本 ${ordinal}：谢谢你分享这些想法。`);
      await wait(plan.slow ? 1600 : 650);
      if (res.destroyed) return;
      if (plan.partialFailure) { res.write(`data: ${JSON.stringify({error: {message: 'Synthetic failure after partial output', type: 'server_error'}})}\n\ndata: [DONE]\n\n`); res.end(); return; }
      send(reply ? reply.slice(30) : ordinal % 2 ? '我会在下周继续跟进，并及时分享进展。' : '我会整理讨论中的重点，下周再与你确认后续安排。');
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
    // 先在隔离浏览器内部选择常驻扩展页，再关闭用例页，避免关闭 active tab 后由浏览器自行选择焦点目标。
    // 这里只使用现有 helper 的 chrome.tabs.update；创建页面时的 macOS 前台与窗口 guard 仍原样执行。
    const closePage = async p => {
      assert.notEqual(p, popup, 'the resident extension tab stays open until browser cleanup'); assert(!popup.isClosed(), 'the resident extension tab must remain available'); assert(!p.isClosed(), 'test page closes exactly once');
      const closingUrl = p.url(); await activateExtensionTabWithoutForeground(context, popup, 12000);
      const parked = await popup.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); return {id: tab?.id, windowId: tab?.windowId, active: tab?.active}; });
      assert.equal(parked.active, true, 'resident extension tab is active before closing the test page');
      const closure = {url: closingUrl, parkedTabId: parked.id, parkedWindowId: parked.windowId, parkedActive: parked.active, closed: false}; report.tabClosures.push(closure);
      await p.close(); closure.closed = true; currentPage = popup;
    };
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
    const assertSettings = async (p, defaults = false) => {
      const scope = p.locator('.writing-settings');
      await scope.waitFor(); await scope.getByRole('switch', {name: '启用写作助手', exact: true}).waitFor();
      assert.equal(await scope.getByRole('switch').count(), 1); assert.equal(await scope.getByRole('switch', {name: '启用写作助手', exact: true}).count(), 1);
      assert(!/使用偏好|禁用网站|写作快捷键|显示回复按钮/.test(await scope.innerText()));
      assert.equal(await scope.getByRole('combobox', {name: '输出语言', exact: true}).count(), 1); assert.equal(await scope.getByRole('radiogroup').count(), 4);
      for (const [name, selected] of [['长度', '简短'], ['风格', '自动'], ['语气', '自然'], ['您的角色', '自动']]) {
        assert.equal(await scope.getByRole('combobox', {name, exact: true}).count(), 0, `${name} exposes direct choices, not a dropdown`);
        const group = scope.getByRole('radiogroup', {name, exact: true}); assert.equal(await group.count(), 1); assert.equal(await group.getByRole('radio', {checked: true}).count(), 1);
        if (defaults) assert.equal(await group.getByRole('radio', {name: selected, exact: true}).getAttribute('aria-checked'), 'true', `${name} keeps the intended fresh default`);
      }
      const icon = p.locator('button[data-section="settings-writing"] .nav-icon'); assert.equal(await icon.innerText(), '✎'); assert.equal(await icon.locator('img').count(), 0);
    };
    await assertSettings(settings, true); await shot(settings, 'writing-settings-light');
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
    const preview = p => p.getByRole('region', {name: '生成正文预览', exact: true});
    const readDraft = async p => await output(p).isVisible() ? output(p).inputValue() : (await preview(p).textContent()).trim();
    const beginEdit = async p => { await p.getByRole('button', {name: '编辑正文', exact: true}).click(); await output(p).waitFor(); assert.equal(await output(p).isEditable(), true); };
    const finishEdit = async p => { await p.getByRole('button', {name: '完成编辑', exact: true}).click(); await preview(p).waitFor(); assert.equal(await output(p).count(), 0); };
    const instruction = p => p.getByRole('textbox', {name: '写作要求', exact: true});
    await entry(firstPage).waitFor(); assert.equal(requests.length, 0);
    await entry(firstPage).click(); await firstPage.getByRole('button', {name: '设置写作服务', exact: true}).waitFor();
    assert.match(await dialog(firstPage).innerText(), /先选择一个 AI 服务/); assert.equal(requests.length, 0);
    const priorPages = new Set(context.pages()); await firstPage.getByRole('button', {name: '设置写作服务', exact: true}).click();
    const openedSettings = await until(() => context.pages().find(p => !priorPages.has(p) && p.url() === `${origin}/options.html#settings-writing`), 'real writing settings navigation');
    capture(openedSettings, 'setup-navigation'); await openedSettings.getByRole('heading', {name: '写作助手', exact: true}).waitFor(); await shot(openedSettings, 'writing-service-setup-navigation'); await closePage(openedSettings);
    report.cases.push('default enabled, automatic entry, single settings switch, plain navigation icon, popup absence and unsupported machine service setup navigation');
    // 从真实设置控件关闭，立即销毁设置页，再读持久化和已打开网页的挂载状态。
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await closePage(settings);
    await until(async () => (await read()).writing.enabled === false, 'immediate-close disabled preference');
    await firstPage.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'});
    settings = await page(`${origin}/options.html#settings-writing`, 'settings-reopened'); await assertSettings(settings);
    assert.equal(await settings.getByRole('switch', {name: '启用写作助手', exact: true}).getAttribute('aria-checked'), 'false'); await shot(settings, 'writing-settings-disabled-reopened');
    report.persistenceCases.push({field: 'writing.enabled', before: true, after: false, closedImmediately: true, reopened: false}); report.quickClose = true; report.crossPageSync = true;
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await until(async () => (await read()).writing.enabled === true); await entry(firstPage).waitFor();
    // 连续两次真实控件修改，最终开启值必须持久化；只影响隔离 profile。
    await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click(); await settings.getByRole('switch', {name: '启用写作助手', exact: true}).click();
    await until(async () => (await read()).writing.enabled === true); await closePage(settings); settings = await page(`${origin}/options.html#settings-writing`, 'settings-enabled-reopened');
    assert.equal(await settings.getByRole('switch', {name: '启用写作助手', exact: true}).getAttribute('aria-checked'), 'true'); report.latestWriteWins = true;
    await closePage(firstPage);
    await patch({service: 'openai', token: {...initial.token, openai: 'synthetic-writing-key'}, proxy: {...initial.proxy, openai: `http://127.0.0.1:${server.address().port}/v1/chat/completions`}, writing: {...(await read()).writing, service: 'openai', model: 'writing-fixture'}});
    const assertRequestCount = async (expected, description) => { await until(() => requests.length >= expected, description); assert.equal(requests.length, expected, description); };
    const complete = async (p, markdown = false) => { await p.getByRole('button', {name: '复制正文', exact: true}).waitFor(); await preview(p).waitFor(); assert.equal(await preview(p).getAttribute('aria-busy'), 'false'); assert.equal(await output(p).count(), 0, 'completed drafts default to Markdown preview'); const text = await readDraft(p); if (!markdown) { assert.match(text, /^回复版本 \d+：/); assert.match(text, /下周/); } return text; };
    const requestBody = index => requests[index].body;
    const quotedData = body => { const content = body.messages.at(-1).content; const marker = '草稿与参考内容（引用数据）：\n'; const parts = content.split(marker); assert.equal(parts.length, 2, 'quoted data has one explicit boundary after expression preferences'); return JSON.parse(parts[1]); };
    const expressionData = body => JSON.parse(body.messages.at(-1).content.split('表达偏好（仅调整表达方式）：\n')[1].split('\n\n草稿与参考内容（引用数据）：')[0]);
    const oneGeneration = async (p, action, plan) => { const before = requests.length; if (plan) responsePlans.push(plan); await action(); await assertRequestCount(before + 1, 'one generation per user action'); const text = await complete(p, Boolean(plan?.markdown)); await wait(180); assert.equal(requests.length, before + 1, 'completed generation must not repeat'); return {text, body: requestBody(before)}; };
    const selectStyle = (p, group, name) => p.getByRole('radiogroup', {name: group, exact: true}).getByRole('radio', {name, exact: true}).click();
    const assertStyle = async (p, values = {长度: '简短', 风格: '自动', 语气: '自然', 您的角色: '自动'}) => { assert.equal(await p.getByRole('radiogroup').count(), 4); for (const [group, name] of Object.entries(values)) assert.equal(await p.getByRole('radiogroup', {name: group, exact: true}).getByRole('radio', {name, exact: true}).getAttribute('aria-checked'), 'true'); };
    const chooseLanguage = async (p, query, name) => { await p.getByRole('button', {name: '输出语言', exact: true}).click(); await p.getByRole('searchbox', {name: '搜索输出语言', exact: true}).fill(query); await p.getByRole('listbox', {name: '输出语言', exact: true}).getByRole('option', {name, exact: true}).click(); };
    const startSampling = async p => {
      await dialog(p).waitFor(); await p.locator('.writing-panel').evaluate(async element => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.writingSamples = []; window.sampleWriting = true; const sample = () => { if (!window.sampleWriting) return; const rect = element.getBoundingClientRect(); window.writingSamples.push({x: rect.x, y: rect.y, width: rect.width, height: rect.height}); requestAnimationFrame(sample); }; sample(); });
    };
    const endSampling = async (p, site) => { const samples = await p.evaluate(() => { window.sampleWriting = false; return window.writingSamples; }); assert(samples.length >= 5, 'streaming must include multiple visible frames'); const deltas = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.max(...samples.map(rect => rect[key])) - Math.min(...samples.map(rect => rect[key]))])); assert(Object.values(deltas).every(delta => delta === 0), `zero streaming jitter: ${JSON.stringify(deltas)}`); report.cardStability.push({site, sampleCount: samples.length, deltas}); };
    if (runs('settings')) {
      const beforeSettingsConfig = await read(); const beforeSettingsRequests = requests.length;
      const settingControl = label => label === '输出语言' ? settings.locator('.el-select').filter({has: settings.getByRole('combobox', {name: label, exact: true})}) : settings.getByRole('radiogroup', {name: label, exact: true});
      const chooseSetting = async (label, name) => {
        if (label !== '输出语言') { const choice = settingControl(label).getByRole('radio', {name, exact: true}); await choice.click(); assert.equal(await choice.getAttribute('aria-checked'), 'true'); return; }
        const combobox = settings.getByRole('combobox', {name: label, exact: true});
        const listboxId = await combobox.getAttribute('aria-controls'); assert(listboxId, `${label} identifies its own options list`);
        const listbox = settings.locator(`[role="listbox"][id=${JSON.stringify(listboxId)}]`);
        await settingControl(label).click(); await until(async () => await combobox.getAttribute('aria-expanded') === 'true', `${label} options opened`); await listbox.waitFor({state: 'visible'});
        await listbox.getByRole('option', {name, exact: true}).click();
        await until(async () => await combobox.getAttribute('aria-expanded') === 'false', `${label} options closed`); await listbox.waitFor({state: 'hidden'});
      };
      const settingValue = label => (label === '输出语言' ? settingControl(label).locator('.el-select__placeholder') : settingControl(label).getByRole('radio', {checked: true})).textContent().then(value => value.trim());
      const expectWriting = async expected => until(async () => { const value = (await read()).writing; return Object.entries(expected).every(([key, wanted]) => value[key] === wanted); }, 'settings writing preferences persisted');
      assertPreferences(beforeSettingsConfig.writing); await assertSettings(settings, true);
      const chipMetrics = await settings.getByRole('radiogroup', {name: '长度', exact: true}).getByRole('radio', {name: '简短', exact: true}).evaluate(element => ({height: element.getBoundingClientRect().height, fontSize: getComputedStyle(element).fontSize, background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor})); assert.equal(chipMetrics.height, 32); assert.equal(chipMetrics.fontSize, '12px'); assert.notEqual(chipMetrics.background, 'rgba(0, 0, 0, 0)'); report.settingsChipMetrics = chipMetrics;
      for (const [label, name] of [['输出语言', 'English'], ['长度', '详细'], ['风格', '正式'], ['语气', '友好'], ['您的角色', '开发者']]) await chooseSetting(label, name);
      await expectWriting({language: 'en', length: 'detailed', style: 'formal', tone: 'friendly', role: 'developer'}); assert.equal(requests.length, beforeSettingsRequests, 'preset settings never generate a reply');
      await chooseSetting('语气', '自定义'); const customToneField = () => settings.getByRole('textbox', {name: '自定义语气', exact: true}); assert.equal(await customToneField().getAttribute('maxlength'), '100');
      await customToneField().fill('natural'); await expectWriting({tone: 'natural'}); assert.equal(await settingValue('语气'), '自定义'); assert(await customToneField().isVisible()); await customToneField().pressSequentially('，耐心'); await expectWriting({tone: 'natural，耐心'}); assert.equal(await customToneField().inputValue(), 'natural，耐心', 'custom tone remains editable while each character persists');
      await customToneField().fill(''); await expectWriting({tone: 'natural'}); assert(await customToneField().isVisible()); assert.equal(await settingValue('语气'), '自定义'); await customToneField().fill('耐心、鼓励，避免夸张');
      await chooseSetting('您的角色', '自定义'); const customRoleField = () => settings.getByRole('textbox', {name: '自定义角色', exact: true}); assert.equal(await customRoleField().getAttribute('maxlength'), '200'); await customRoleField().fill('auto'); await expectWriting({role: 'auto'}); assert.equal(await settingValue('您的角色'), '自定义'); await customRoleField().pressSequentially('，社区参与者'); await expectWriting({role: 'auto，社区参与者'}); assert.equal(await customRoleField().inputValue(), 'auto，社区参与者'); await customRoleField().fill(''); await expectWriting({role: 'auto'}); assert(await customRoleField().isVisible());
      await customRoleField().fill('协助复现问题的社区参与者'); await closePage(settings);
      const customPreferences = {language: 'en', length: 'detailed', style: 'formal', tone: '耐心、鼓励，避免夸张', role: '协助复现问题的社区参与者'}; await expectWriting(customPreferences); assert.equal(requests.length, beforeSettingsRequests);
      settings = await page(`${origin}/options.html#settings-writing`, 'settings-default-preferences-reopened'); await assertSettings(settings); assert.equal(await settingValue('输出语言'), 'English'); assert.equal(await settingValue('长度'), '详细'); assert.equal(await settingValue('风格'), '正式'); assert.equal(await settingValue('语气'), '自定义'); assert.equal(await customToneField().inputValue(), customPreferences.tone); assert.equal(await customRoleField().inputValue(), customPreferences.role); await shot(settings, 'writing-default-preferences-persisted');
      report.persistenceCases.push({field: 'writing.expression', after: customPreferences, closedImmediately: true, reopened: customPreferences});
      const settingsCard = await page('https://github.com/fluentread-fixture/project/issues/31?fixture=draft', 'settings-open-card-sync'); const firstSettingsDraft = await oneGeneration(settingsCard, () => entry(settingsCard).click()); assert.match(firstSettingsDraft.body.messages[0].content, /输出语言：English（en）/); assert.match(firstSettingsDraft.body.messages[0].content, /篇幅：详细/); assert.deepEqual(expressionData(firstSettingsDraft.body), {style: '正式', tone: customPreferences.tone, role: customPreferences.role});
      const beforeExternalChange = requests.length;
      for (const [label, name] of [['输出语言', '繁體中文'], ['长度', '简短'], ['风格', '中性'], ['语气', '温暖'], ['您的角色', '同事']]) await chooseSetting(label, name);
      await expectWriting({language: 'zh-Hant', length: 'short', style: 'neutral', tone: 'warm', role: 'colleague'}); await wait(250); assert.equal(requests.length, beforeExternalChange, 'external settings update does not rewrite the open card'); assert.equal(await readDraft(settingsCard), firstSettingsDraft.text); assert.equal((await settingsCard.getByRole('button', {name: '输出语言', exact: true}).innerText()).trim(), 'English', 'existing draft retains its actual output-language label');
      await settingsCard.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(settingsCard, {长度: '简短', 风格: '中性', 语气: '温暖', 您的角色: '同事'}); await settingsCard.getByRole('button', {name: '取消', exact: true}).click();
      const synchronizedDraft = await oneGeneration(settingsCard, () => settingsCard.getByRole('button', {name: '重新生成', exact: true}).click()); assert.equal(quotedData(synchronizedDraft.body).draft, firstSettingsDraft.text); assert.match(synchronizedDraft.body.messages[0].content, /输出语言：繁體中文（zh-Hant）/); assert.match(synchronizedDraft.body.messages[0].content, /篇幅：简短/); assert.deepEqual(expressionData(synchronizedDraft.body), {style: '中性', tone: '温暖', role: '同事'});
      await settingsCard.getByRole('button', {name: '回答风格', exact: true}).click(); for (const [group, name] of [['长度', '标准'], ['风格', '随意'], ['语气', '友好'], ['您的角色', '用户']]) await selectStyle(settingsCard, group, name); await oneGeneration(settingsCard, () => settingsCard.getByRole('button', {name: '应用并改写', exact: true}).click()); await expectWriting({length: 'standard', style: 'casual', tone: 'friendly', role: 'user'});
      await until(async () => await settingValue('长度') === '标准' && await settingValue('风格') === '随意' && await settingValue('语气') === '友好' && await settingValue('您的角色') === '用户', 'card preference application synchronizes the already-open settings page'); await shot(settingsCard, 'writing-settings-and-card-synchronized'); await closePage(settingsCard);
      const beforeThemeChange = requests.length; await patch({theme: 'dark'}); await settings.reload(); await assertSettings(settings); await shot(settings, 'writing-default-preferences-dark'); await settings.setViewportSize({width: 390, height: 844});
      for (const name of ['输出语言', '长度', '风格', '语气', '您的角色']) { const control = settingControl(name); await control.scrollIntoViewIfNeeded(); const bounds = await control.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, `${name} remains within the narrow settings viewport`); if (name !== '输出语言') for (const chip of await control.getByRole('radio').all()) { const chipBox = await chip.boundingBox(); assert(chipBox.x >= bounds.x && chipBox.x + chipBox.width <= bounds.x + bounds.width + 1, `${name} chips wrap within their group`); assert.equal(chipBox.height, 32); } }
      assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await settingControl('输出语言').scrollIntoViewIfNeeded(); await shot(settings, 'writing-default-preferences-mobile-dark'); assert.equal(requests.length, beforeThemeChange);
      await patch({theme: beforeSettingsConfig.theme, to: beforeSettingsConfig.to, writing: {...(await read()).writing, ...defaultExpression}}); await settings.setViewportSize({width: 1440, height: 1000}); await settings.reload(); await assertSettings(settings);
      report.cases.push('settings compact language picker and four direct chip groups persist without model calls, bounded custom tone/role keep editing through preset IDs and blank fallbacks, immediate-close persistence, already-open card uses changed defaults only on the next request, card application syncs settings, and dark 390px wrapping chip layout');
    }
    for (const site of ['github', 'gmail'].filter(runs)) {
      await patch({writing: {...(await read()).writing, ...defaultExpression}});
      const p = await page(site === 'github' ? 'https://github.com/fluentread-fixture/project/issues/2' : 'https://mail.google.com/mail/u/0/#inbox/fixture', site); currentPage = p;
      await activateExtensionTabWithoutForeground(context, p, 12000); await entry(p).waitFor();
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
      const languageResult = await oneGeneration(p, () => chooseLanguage(p, 'English', 'English'));
      assert.equal(quotedData(languageResult.body).draft, firstText); assert.match(languageResult.body.messages[0].content, /输出语言：English（en）/); assert(!languageResult.body.messages.at(-1).content.includes('ONE_SHOT_IMPROVEMENT')); assert.equal(await instruction(p).inputValue(), 'ONE_SHOT_IMPROVEMENT'); assert.equal((await read()).writing.language, 'en');
      await p.getByRole('button', {name: '上一版', exact: true}).click(); assert.equal(await readDraft(p), firstText); await p.getByRole('button', {name: '下一版', exact: true}).click(); assert.equal(await readDraft(p), languageResult.text);
      const savedBeforeStyle = (await read()).writing; const beforeStyle = requests.length;
      await p.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(p);
      const pickedStyle = {长度: '详细', 风格: '正式', 语气: '友好', 您的角色: '维护者'};
      for (const [group, value] of Object.entries(pickedStyle)) await selectStyle(p, group, value);
      await assertStyle(p, pickedStyle); await wait(200); assert.equal(requests.length, beforeStyle, 'staged radio changes never generate'); assert.deepEqual((await read()).writing, savedBeforeStyle, 'staged values are not persisted');
      await shot(p, `${site}-staged-answer-style`); await p.getByRole('button', {name: '取消', exact: true}).click(); assert.equal(await readDraft(p), languageResult.text); assert.deepEqual((await read()).writing, savedBeforeStyle); assert.equal(requests.length, beforeStyle, 'cancel does not generate or save');
      await p.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(p);
      for (const [group, value] of Object.entries(pickedStyle)) await selectStyle(p, group, value);
      const styleResult = await oneGeneration(p, () => p.getByRole('button', {name: '应用并改写', exact: true}).click());
      assert.equal(quotedData(styleResult.body).draft, languageResult.text); assert.match(styleResult.body.messages[0].content, /篇幅：详细/); assert.match(styleResult.body.messages[0].content, /语气：友好/); assert.deepEqual(expressionData(styleResult.body), {style: '正式', tone: '友好', role: '维护者'});
      assert.deepEqual((await read()).writing, {...savedBeforeStyle, length: 'detailed', style: 'formal', tone: 'friendly', role: 'maintainer'}); assert.equal(await instruction(p).inputValue(), 'ONE_SHOT_IMPROVEMENT'); assert(!styleResult.body.messages.at(-1).content.includes('ONE_SHOT_IMPROVEMENT'));
      await p.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(p, pickedStyle); const beforeCustom = requests.length;
      await selectStyle(p, '语气', '自定义'); await selectStyle(p, '您的角色', '自定义');
      const customTone = p.getByRole('textbox', {name: '自定义语气', exact: true}); const customRole = p.getByRole('textbox', {name: '自定义角色', exact: true});
      assert.equal(await customTone.getAttribute('maxlength'), '100'); assert.equal(await customRole.getAttribute('maxlength'), '200'); assert.equal(await p.getByRole('button', {name: '应用并改写', exact: true}).isDisabled(), true);
      await customTone.fill('耐心而简洁'); await customRole.fill('帮助复现问题的社区贡献者'); assert.equal(requests.length, beforeCustom);
      const customResult = await oneGeneration(p, () => p.getByRole('button', {name: '应用并改写', exact: true}).click()); assert.equal(quotedData(customResult.body).draft, styleResult.text); assert.deepEqual(expressionData(customResult.body), {style: '正式', tone: '耐心而简洁', role: '帮助复现问题的社区贡献者'}); assert.equal(await instruction(p).inputValue(), 'ONE_SHOT_IMPROVEMENT');
      const improved = await oneGeneration(p, () => p.getByRole('button', {name: '改进草稿', exact: true}).click());
      assert.equal(quotedData(improved.body).draft, customResult.text); assert(improved.body.messages.at(-1).content.includes('ONE_SHOT_IMPROVEMENT')); assert.equal(await instruction(p).inputValue(), '');
      assert.notEqual(firstText, improved.text);
      const beforeFailure = requests.length; responsePlans.push({fail: true}); await instruction(p).fill('Keep the previous draft if this fails'); await p.getByRole('button', {name: '改进草稿', exact: true}).click(); await assertRequestCount(beforeFailure + 1, 'single failed request'); await p.getByRole('alert').waitFor();
      assert.equal(await readDraft(p), improved.text); assert.equal(await instruction(p).inputValue(), 'Keep the previous draft if this fails');
      const retried = await oneGeneration(p, () => p.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(quotedData(retried.body).draft, improved.text); assert.equal(await instruction(p).inputValue(), '');
      const beforeStop = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeStop + 1, 'slow rewrite starts'); await until(async () => (await readDraft(p)) !== retried.text, 'partial rewrite'); await p.getByRole('button', {name: '停止', exact: true}).click();
      assert.equal(await readDraft(p), retried.text); assert.match(await p.getByRole('status').innerText(), /已保留/); await wait(1800); assert.equal(await readDraft(p), retried.text); assert.equal(requests.length, beforeStop + 1);
      await p.getByRole('button', {name: '插入回复', exact: true}).click(); await dialog(p).waitFor({state: 'hidden'});
      assert.equal(await p.locator('#editor').evaluate(element => element.value ?? element.innerText), retried.text); assert.equal(await p.evaluate(() => document.activeElement?.id), 'editor'); assert.equal(await p.evaluate(() => window.sent || 0), 0);
      const beforeReopen = requests.length; await entry(p).click(); await dialog(p).waitFor(); assert.equal(await readDraft(p), retried.text); await wait(850); assert.equal(requests.length, beforeReopen, 'same editor reopens existing session');
      const staleIndex = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(staleIndex + 1, 'stale draft generation');
      await p.locator('#editor').evaluate(element => { if ('value' in element) element.value = 'New user draft'; else element.textContent = 'New user draft'; element.dispatchEvent(new Event('input', {bubbles: true})); });
      await complete(p); await p.getByRole('button', {name: '插入回复', exact: true}).click(); assert.match(await p.getByRole('alert').innerText(), /已被修改/); assert.equal(await p.locator('#editor').evaluate(element => element.value ?? element.innerText), 'New user draft');
      await p.getByRole('button', {name: '关闭写作助手', exact: true}).click(); const beforeShortcut = requests.length;
      for (const key of ['Alt+W', 'Alt+Shift+J']) { await p.locator('#editor').focus(); await p.keyboard.press(key); await wait(180); assert.equal(await dialog(p).isVisible(), false, `${key} has no writing shortcut`); } assert.equal(requests.length, beforeShortcut);
      await oneGeneration(p, () => entry(p).click());
      const beforeRoute = requests.length; responsePlans.push({slow: true}); await p.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeRoute + 1, 'route-owned request');
      await p.evaluate(() => history.pushState({}, '', location.pathname + '?route=changed' + (location.hash ? '#inbox/changed' : ''))); await dialog(p).waitFor({state: 'hidden'}); await wait(1800); assert.equal(await dialog(p).isVisible(), false); assert.equal(requests.length, beforeRoute + 1); assert.equal(await p.evaluate(() => window.sent || 0), 0);
      report.cases.push(`${site}: native action order, automatic draft exactly once, bounded reference, zero frame jitter, language picker rewrite, staged four-field style cancel/save/apply exactly once including bounded custom tone and role, one-shot improvement, versions, failure/retry, stop preservation, insertion closes and focuses without send, reopen reuse, stale protection, no shortcut and SPA cancellation`); await closePage(p);
      await patch({writing: {...(await read()).writing, ...defaultExpression}});
    }
    if (runs('recovery')) {
    // 草稿来源标签属于已生成的版本，不能被之后选择的模型或失败请求覆盖。
    const originalWriting = (await read()).writing;
    await patch({writing: {...originalWriting, model: 'writing-fixture-a'}});
    const modelPage = await page('https://github.com/fluentread-fixture/project/issues/20', 'writing-model-ownership');
    const modelA = await oneGeneration(modelPage, () => entry(modelPage).click());
    const modelLabel = () => modelPage.locator('.writing-provider small').innerText();
    assert.equal(modelA.body.model, 'writing-fixture-a'); assert.equal(await modelLabel(), 'writing-fixture-a-actual');
    const beforeModelChange = requests.length; await patch({writing: {...originalWriting, model: 'writing-fixture-b'}}); await wait(250);
    assert.equal(await readDraft(modelPage), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual'); assert.equal(requests.length, beforeModelChange);
    responsePlans.push({fail: true}); await modelPage.getByRole('button', {name: '重新生成', exact: true}).click(); await assertRequestCount(beforeModelChange + 1, 'new model failed rewrite'); await modelPage.getByRole('alert').waitFor();
    assert.equal(requestBody(beforeModelChange).model, 'writing-fixture-b'); assert.equal(await readDraft(modelPage), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual');
    const modelB = await oneGeneration(modelPage, () => modelPage.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(modelB.body.model, 'writing-fixture-b'); assert.equal(quotedData(modelB.body).draft, modelA.text); assert.equal(await modelLabel(), 'writing-fixture-b-actual');
    await modelPage.getByRole('button', {name: '上一版', exact: true}).click(); assert.equal(await readDraft(modelPage), modelA.text); assert.equal(await modelLabel(), 'writing-fixture-a-actual'); await shot(modelPage, 'writing-model-a-version');
    await modelPage.getByRole('button', {name: '下一版', exact: true}).click(); assert.equal(await readDraft(modelPage), modelB.text); assert.equal(await modelLabel(), 'writing-fixture-b-actual'); await shot(modelPage, 'writing-model-b-version'); await closePage(modelPage); await patch({writing: originalWriting});
    report.cases.push('model metadata follows draft ownership across configuration change, failed rewrite and previous/next version selection');
    const partialPage = await page('https://github.com/fluentread-fixture/project/issues/21', 'writing-partial-stream-failure');
    const beforePartialFailure = requests.length; responsePlans.push({partialFailure: true, slow: true}); await entry(partialPage).click(); await assertRequestCount(beforePartialFailure + 1, 'first generation partial failure');
    const partialText = await until(async () => { const text = await readDraft(partialPage); return /^回复版本 \d+：/.test(text) && await preview(partialPage).getAttribute('aria-busy') === 'true' ? text : null; }, 'partial text before stream error');
    await partialPage.getByRole('alert').waitFor(); assert.equal(await readDraft(partialPage), partialText); assert.equal(await preview(partialPage).getAttribute('aria-busy'), 'false');
    await beginEdit(partialPage); const editedPartial = `${partialText} Manual continuation after the interrupted response.`; await output(partialPage).fill(editedPartial); await finishEdit(partialPage); assert.equal(await readDraft(partialPage), editedPartial); await shot(partialPage, 'writing-first-stream-error-retained');
    const partialRecovery = await oneGeneration(partialPage, () => partialPage.getByRole('button', {name: '重试', exact: true}).click()); assert.equal(quotedData(partialRecovery.body).draft, editedPartial); assert.equal(await partialPage.evaluate(() => window.sent || 0), 0); await closePage(partialPage);
    report.cases.push('first stream error preserves received text as an editable draft and retry uses the manually continued partial draft');
    }
    if (runs('layout')) {
    // 初始下方展开；移动后上方也有空间，卡片仍须保持本次打开的展开方向。
    const layoutPage = await page('https://github.com/fluentread-fixture/project/issues/22?fixture=draft', 'writing-layout-follow');
    await layoutPage.setViewportSize({width: 1440, height: 1200});
    const measuredLayoutViewport = await layoutPage.evaluate(() => ({width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height ?? innerHeight, visualTop: visualViewport?.offsetTop ?? 0}));
    assert.equal(measuredLayoutViewport.width, 1440); assert.equal(measuredLayoutViewport.height, 1200, 'layout fixture uses measured content height, not outer browser window height');
    report.layoutFollow = {requestedViewport: {width: 1440, height: 1200}, measuredViewport: measuredLayoutViewport}; await entry(layoutPage).waitFor();
    await layoutPage.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; document.body.style.overflowAnchor = 'none'; document.body.style.minHeight = '1800px'; window.scrollTo(0, 0); const main = document.querySelector('main'); const host = document.querySelector('[data-fluent-read-ui="writing-entry"]'); main.style.marginTop = `${parseFloat(getComputedStyle(main).marginTop) + 450 - host.getBoundingClientRect().top}px`; });
    await oneGeneration(layoutPage, () => entry(layoutPage).click());
    const layout = async () => ({anchor: await layoutPage.locator('[data-fluent-read-ui="writing-entry"]').boundingBox(), card: await layoutPage.locator('.writing-panel').boundingBox()});
    const initialLayout = await layout(); report.layoutFollow.initial = initialLayout; assert(Math.abs(initialLayout.anchor.y - 450) < 1);
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
    report.layoutFollow.insertedBefore = shiftedLayout; await shot(layoutPage, 'writing-layout-follows-fixed-direction'); await closePage(layoutPage); report.cases.push('editor resize and preceding DOM insertion move the card with its anchor while preserving the opening direction');
    }
    if (runs('context')) {
    const beforeContextConfig = await read();
    await patch({to: 'zh-Hant', writing: {...beforeContextConfig.writing, ...defaultExpression}});
    const issue421 = await page('https://github.com/FluentRead/FluentRead/issues/421?fixture=issue421', 'issue421-context-and-markdown');
    const issueReply = await oneGeneration(issue421, () => entry(issue421).click(), {markdown: true});
    const issueData = quotedData(issueReply.body); assert.equal(issueData.draft, '');
    assert.match(issueData.context, /当前项目：FluentRead\/FluentRead/); assert.match(issueData.context, /帖子类型：Issue #421/); assert.match(issueData.context, /页面地址：https:\/\/github.com\/FluentRead\/FluentRead\/issues\/421/); assert.match(issueData.context, /帖子标题：同一段话出现了两次翻译/); assert.match(issueData.context, /原帖：[\s\S]*https:\/\/github.com\/planetscale\/vtprotobuf/); assert(!issueData.context.includes('当前讨论：'), 'screenshot-and-link issue has no invented comments');
    assert.match(issueReply.body.messages[0].content, /回应整个帖子/); assert.match(issueReply.body.messages[0].content, /不输出链接项目的百科介绍/); assert.match(issueReply.body.messages[0].content, /不能猜测未读取的截图内容/); assert.match(issueReply.body.messages[0].content, /不自称维护者/); assert.match(issueReply.body.messages[0].content, /不要用代码围栏包裹整篇回复/); assert.match(issueReply.body.messages[0].content, /输出语言：繁體中文（zh-Hant）/); assert.match(issueReply.body.messages[0].content, /篇幅：简短/); assert.deepEqual(expressionData(issueReply.body), {style: '自动', tone: '自然', role: '自动'});
    const languageButton = () => issue421.getByRole('button', {name: '输出语言', exact: true});
    assert.equal((await read()).writing.language, 'target'); assert.equal((await languageButton().innerText()).trim(), '繁體中文'); assert.equal(await languageButton().getAttribute('title'), '跟随目标语言');
    const assertMarkdown = async p => { assert.equal(await preview(p).locator('[data-reading-answer]').count(), 1); assert.equal(await preview(p).locator('strong').first().innerText(), '重复翻译'); assert.equal(await preview(p).locator('li').count(), 2); assert.equal(await preview(p).locator('pre code').innerText(), 'original -> translated'); assert.equal(await preview(p).locator('a, img, script, iframe').count(), 0); assert((await preview(p).textContent()).includes('重复翻译')); assert(!(await preview(p).textContent()).includes('**重复翻译**')); };
    await assertMarkdown(issue421); await shot(issue421, 'issue421-markdown-preview');
    const beforeTargetChange = requests.length; await patch({to: 'en'}); await wait(250); assert.equal(requests.length, beforeTargetChange); assert.equal((await languageButton().innerText()).trim(), '繁體中文', 'external target change cannot relabel a completed draft');
    const newLanguage = await oneGeneration(issue421, () => issue421.getByRole('button', {name: '重新生成', exact: true}).click(), {markdown: true}); assert.match(newLanguage.body.messages[0].content, /输出语言：English（en）/); assert.equal((await languageButton().innerText()).trim(), 'English'); assert.equal((await read()).writing.language, 'target');
    await issue421.getByRole('button', {name: '上一版', exact: true}).click(); assert.equal((await languageButton().innerText()).trim(), '繁體中文'); await issue421.getByRole('button', {name: '下一版', exact: true}).click(); assert.equal((await languageButton().innerText()).trim(), 'English');
    const beforePicker = requests.length; await languageButton().click();
    const languageOptions = issue421.getByRole('listbox', {name: '输出语言', exact: true});
    for (const name of ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Русский', 'Español']) assert.equal(await languageOptions.getByRole('option', {name, exact: true}).count(), 1, `translation target ${name} remains selectable`);
    assert.equal(await languageOptions.getByRole('option', {name: /跟随目标语言/}).getAttribute('aria-selected'), 'true'); await issue421.getByRole('searchbox', {name: '搜索输出语言', exact: true}).fill('zh-Hant'); assert.equal(await languageOptions.getByRole('option').count(), 1); assert.equal(await languageOptions.getByRole('option', {name: '繁體中文', exact: true}).count(), 1); await shot(issue421, 'writing-searchable-language-picker'); await issue421.getByRole('button', {name: '返回草稿', exact: true}).click(); assert.equal(requests.length, beforePicker); assert.equal((await read()).writing.language, 'target');
    const beforeStaged = requests.length; const savedExpression = (await read()).writing;
    await issue421.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(issue421);
    for (const [group, value] of Object.entries({长度: '标准', 风格: '中性', 语气: '真诚', 您的角色: '开发者'})) await selectStyle(issue421, group, value);
    await wait(180); assert.equal(requests.length, beforeStaged); assert.deepEqual((await read()).writing, savedExpression); await shot(issue421, 'issue421-staged-style'); await issue421.getByRole('button', {name: '取消', exact: true}).click(); assert.equal(requests.length, beforeStaged); assert.deepEqual((await read()).writing, savedExpression); await beginEdit(issue421); assert.equal(await output(issue421).inputValue(), markdownReply); await finishEdit(issue421);
    await issue421.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(issue421); for (const [group, value] of Object.entries({长度: '标准', 风格: '中性', 语气: '真诚', 您的角色: '开发者'})) await selectStyle(issue421, group, value);
    const styled = await oneGeneration(issue421, () => issue421.getByRole('button', {name: '应用并改写', exact: true}).click(), {markdown: true}); assert.equal(quotedData(styled.body).draft, markdownReply); assert.deepEqual(expressionData(styled.body), {style: '中性', tone: '真诚', role: '开发者'}); assert.deepEqual((await read()).writing, {...savedExpression, length: 'standard', style: 'neutral', tone: 'sincere', role: 'developer'});
    await issue421.getByRole('button', {name: '参考内容', exact: true}).click(); const reference = issue421.getByRole('textbox', {name: '写作参考内容', exact: true}); assert.equal(await reference.inputValue(), issueData.context); assert.equal(await reference.isEditable(), true); const revisedContext = `${issueData.context}\n\n补充说明：重复翻译出现在同一段落。`; await reference.fill(revisedContext); await shot(issue421, 'issue421-complete-editable-reference');
    const restarted = await oneGeneration(issue421, () => issue421.getByRole('button', {name: '重新起草', exact: true}).click(), {markdown: true}); assert.deepEqual(quotedData(restarted.body), {draft: '', context: revisedContext}); assert.match(restarted.body.messages[0].content, /起草回复/);
    await beginEdit(issue421); assert.equal(await output(issue421).inputValue(), markdownReply); const editedMarkdown = `${markdownReply}\n\n**补充**：请提供复现步骤。`; await output(issue421).fill(editedMarkdown); await shot(issue421, 'issue421-edit-markdown-source'); await finishEdit(issue421); assert((await preview(issue421).textContent()).includes('补充')); assert.equal(await preview(issue421).locator('strong').last().innerText(), '补充');
    await issue421.getByRole('button', {name: '插入回复', exact: true}).click(); await dialog(issue421).waitFor({state: 'hidden'}); assert.equal(await issue421.locator('#editor').inputValue(), editedMarkdown, 'GitHub keeps raw Markdown'); assert.equal(await issue421.evaluate(() => document.activeElement?.id), 'editor'); assert.equal(await issue421.evaluate(() => window.sent || 0), 0); await shot(issue421, 'issue421-inserted-markdown'); await closePage(issue421);
    await patch({to: beforeContextConfig.to, writing: {...(await read()).writing, ...defaultExpression}});
    const markdownMail = await page('https://mail.google.com/mail/u/0/#inbox/markdown', 'gmail-markdown-plain-insertion'); await oneGeneration(markdownMail, () => entry(markdownMail).click(), {markdown: true}); await assertMarkdown(markdownMail); await beginEdit(markdownMail); assert.equal(await output(markdownMail).inputValue(), markdownReply); await output(markdownMail).fill(editedMarkdown); await finishEdit(markdownMail); await shot(markdownMail, 'gmail-markdown-preview');
    await markdownMail.getByRole('button', {name: '插入回复', exact: true}).click(); await dialog(markdownMail).waitFor({state: 'hidden'}); assert.equal(await markdownMail.locator('#editor').innerText(), `${plainReply}\n\n补充：请提供复现步骤。`, 'Gmail inserts readable plain text with list markers, code and link destinations'); assert.equal(await markdownMail.evaluate(() => document.activeElement?.id), 'editor'); assert.equal(await markdownMail.evaluate(() => window.sent || 0), 0); await shot(markdownMail, 'gmail-inserted-plain-text'); await closePage(markdownMail);
    report.cases.push('reported Issue #421 title/project/body-link context and complete-thread prompt guard, all target languages, target-language metadata ownership, staged style cancel/apply once, reviewed reference restart, safe Markdown preview/edit, GitHub raw Markdown and Gmail plain insertion without send');
    }
    if (runs('compose')) {
    const newMail = await page('https://mail.google.com/mail/u/0/?fixture=new#compose', 'new-mail');
    await entry(newMail).waitFor(); const beforeNew = requests.length; await entry(newMail).click(); await dialog(newMail).waitFor(); await wait(850);
    assert.equal(requests.length, beforeNew); assert.match(await dialog(newMail).innerText(), /写下回复要点/); assert.equal(await output(newMail).count(), 0); assert.equal(await newMail.getByRole('button', {name: '生成回复', exact: true}).isDisabled(), true);
    await newMail.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(newMail); await selectStyle(newMail, '风格', '随意'); await newMail.getByRole('button', {name: '应用', exact: true}).click(); await instruction(newMail).waitFor(); await wait(200); assert.equal(requests.length, beforeNew, 'empty-mail style save does not invent a request'); assert.equal((await read()).writing.style, 'casual');
    await instruction(newMail).fill('Invite the team to a short discussion.'); const composed = await oneGeneration(newMail, () => newMail.getByRole('button', {name: '生成回复', exact: true}).click()); assert.deepEqual(quotedData(composed.body), {draft: '', context: ''}); await shot(newMail, 'new-mail-from-points'); await closePage(newMail);
    await patch({writing: {...(await read()).writing, ...defaultExpression}});
    const subjectMail = await page('https://mail.google.com/mail/u/0/?fixture=subject#compose', 'subject-only-mail'); await entry(subjectMail).waitFor(); const beforeSubject = requests.length; await entry(subjectMail).click(); await instruction(subjectMail).waitFor(); await wait(850); assert.equal(requests.length, beforeSubject, 'subject-only compose requires an explicit drafting action'); assert.equal(await preview(subjectMail).count(), 0);
    await subjectMail.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(subjectMail); const subjectReply = await oneGeneration(subjectMail, () => subjectMail.getByRole('button', {name: '应用并起草', exact: true}).click()); assert.deepEqual(quotedData(subjectReply.body), {draft: '', context: '邮件主题：Project check-in'}); assert.match(subjectReply.body.messages[0].content, /根据用户要求起草完整文本/); await shot(subjectMail, 'subject-only-mail-explicit-drafting'); await closePage(subjectMail);
    const multiple = await page('https://mail.google.com/mail/u/0/?fixture=multiple#inbox', 'gmail-isolated-conversations'); await until(async () => (await entry(multiple).count()) === 2);
    for (const [id, own, other] of [['first-editor', 'ONE', 'TWO'], ['second-editor', 'TWO', 'ONE']]) {
      const generated = await oneGeneration(multiple, () => multiple.locator(`#${id}-conversation`).getByRole('button', {name: '写作助手', exact: true}).click()); const data = quotedData(generated.body);
      assert.equal(data.draft, `DRAFT_THREAD_${own}`); assert(data.context.includes(`THREAD_${own}`)); assert(!data.context.includes(`THREAD_${other}`)); await multiple.getByRole('button', {name: '关闭写作助手', exact: true}).click();
    }
    await closePage(multiple); report.cases.push('new compose waits for points and excludes background mail; multiple Gmail drafts use only their own conversations');
    const signature = await page('https://mail.google.com/mail/u/0/?fixture=signature#inbox', 'gmail-complex-signature'); await activateExtensionTabWithoutForeground(context, signature, 12000);
    const signatureHtml = await signature.locator('#editor').innerHTML(); const copied = await oneGeneration(signature, () => entry(signature).click()); assert.equal(await signature.getByRole('button', {name: '插入回复', exact: true}).count(), 0); assert.match(await dialog(signature).innerText(), /原草稿含格式/);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: 'https://mail.google.com'}); await signature.getByRole('button', {name: '复制回复', exact: true}).click(); await signature.getByRole('status').waitFor(); assert.match(await signature.getByRole('status').innerText(), /正文已复制/); assert.equal(await signature.evaluate(() => navigator.clipboard.readText()), copied.text);
    assert.equal(await signature.locator('#editor').innerHTML(), signatureHtml); assert.equal(await signature.evaluate(() => window.sent || 0), 0); await shot(signature, 'gmail-complex-signature-copy'); await closePage(signature); report.cases.push('complex rich-text signature provides copy as primary action and preserves original HTML without sending');
    }
    if (runs('dynamic')) {
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
    await patch({disabledExtensionDomains: ['github.com']}); await dynamic.locator('[data-fluent-read-ui="writing-entry"]').waitFor({state: 'detached'}); const excluded = await page('https://github.com/fluentread-fixture/project/pull/2', 'global-site-rule'); await wait(500); assert.equal(await excluded.locator('#fluent-read-writing-assistant').count(), 0); await closePage(excluded); await patch({disabledExtensionDomains: []}); await entry(dynamic).waitFor(); await closePage(dynamic);
    report.cases.push('editor remount cancellation, one replacement entry, disable cancels stream, disabled observer cannot steal another input focus, re-enable automatic injection, anchored scrolling and existing global website rule');
    }
    if (suite === 'presentation') {
      await patch({disabledExtensionDomains: ['github.com']});
      const excluded = await page('https://github.com/fluentread-fixture/project/pull/2', 'presentation-global-site-rule'); await wait(500);
      assert.equal(await excluded.locator('#fluent-read-writing-assistant').count(), 0); assert.equal(await excluded.locator('[data-fluent-read-ui="writing-entry"]').count(), 0);
      await shot(excluded, 'writing-global-site-disabled-fresh-page');
      await patch({disabledExtensionDomains: []}); await entry(excluded).waitFor(); assert.equal(await entry(excluded).count(), 1);
      await shot(excluded, 'writing-global-site-rule-cleared'); await closePage(excluded);
      report.cases.push('presentation: global website rule blocks a fresh GitHub PR and clearing it automatically injects one writing entry');
    }
    if (runs('presentation')) {
    await patch({theme: 'dark'}); await settings.reload(); await assertSettings(settings); await shot(settings, 'writing-settings-dark');
    const dark = await page('https://github.com/fluentread-fixture/project/pull/3', 'dark-pr'); await oneGeneration(dark, () => entry(dark).click()); assert.equal(await dark.locator('.writing-panel.is-dark').count(), 1); assert.equal(await dark.locator('[data-fluent-read-ui="writing-entry"]').getAttribute('data-theme'), 'dark'); await shot(dark, 'writing-panel-dark');
    await dark.setViewportSize({width: 390, height: 844}); await wait(250); const mobileBox = await dark.locator('.writing-panel').boundingBox(); assert(mobileBox.x >= 12 && mobileBox.x + mobileBox.width <= 378 && mobileBox.y >= 12 && mobileBox.y + mobileBox.height <= 832); assert.equal(await dark.locator('.writing-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true); await shot(dark, 'writing-panel-mobile');
    for (const name of ['输出语言', '回答风格', '编辑正文']) assert(await dark.getByRole('button', {name, exact: true}).isVisible());
    const beforeMobileControls = requests.length; const beforeMobilePreferences = (await read()).writing;
    await dark.getByRole('button', {name: '回答风格', exact: true}).click(); await assertStyle(dark); assert.equal(await dark.locator('.writing-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true); await shot(dark, 'writing-style-mobile-dark');
    for (const group of ['长度', '风格', '语气', '您的角色']) { await dark.getByRole('radiogroup', {name: group, exact: true}).scrollIntoViewIfNeeded(); assert(await dark.getByRole('radiogroup', {name: group, exact: true}).isVisible()); }
    await dark.getByRole('button', {name: '取消', exact: true}).click(); await dark.getByRole('button', {name: '输出语言', exact: true}).click(); await dark.getByRole('searchbox', {name: '搜索输出语言', exact: true}).fill('中文'); assert.equal(await dark.getByRole('listbox', {name: '输出语言', exact: true}).getByRole('option', {name: '简体中文', exact: true}).count(), 1); assert.equal(await dark.getByRole('listbox', {name: '输出语言', exact: true}).getByRole('option', {name: '繁體中文', exact: true}).count(), 1); assert.equal(await dark.locator('.writing-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true); await shot(dark, 'writing-language-mobile-dark'); await dark.getByRole('button', {name: '返回草稿', exact: true}).click(); assert.equal(requests.length, beforeMobileControls); assert.deepEqual((await read()).writing, beforeMobilePreferences); await closePage(dark);
    await settings.setViewportSize({width: 390, height: 844}); await shot(settings, 'writing-settings-mobile'); assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const url of ['https://github.com/fluentread-fixture/project', 'https://github.com/fluentread-fixture/project/discussions/1', 'https://mail.google.com/settings']) { const unsupported = await page(url, 'unsupported-route'); await wait(450); assert.equal(await unsupported.locator('[data-fluent-read-ui="writing-entry"]').count(), 0); await closePage(unsupported); }
    report.cases.push('dark Issue/PR surface, 390px panel and settings without horizontal overflow and unsupported routes absent');
    }
    await popup.reload(); await popup.getByRole('heading', {name: '网页翻译', exact: true}).waitFor(); assert.equal(await popup.getByText('写作助手', {exact: true}).count(), 0); assertPreferences((await read()).writing); report.cases.push('popup writing entry and retired preferences remain absent');
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
