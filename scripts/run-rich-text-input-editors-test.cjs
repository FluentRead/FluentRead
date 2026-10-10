// 输入框翻译富文本专项：生产扩展、隔离 Edge、真实按键，在从 CDN 加载的 Quill、ProseMirror、Lexical、Slate、Draft.js 中验证
// 三连触发、编辑器自身模型只含译文（无重复插入）和恢复原文。需要访问 esm.sh 与 cdn.jsdelivr.net；供应商响应为本地确定性夹具。
// --slate-fast-cache 增加 Slate 五轮快速翻译/恢复：三轮即时响应、两轮缓存开启，并断言最后一轮零供应商请求。
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
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-rich-text-editors'));
// 可选压力场景：不在连续写入之间添加同步等待，同时验证真正的供应商零请求缓存命中。
const slateFastCache = process.argv.includes('--slate-fast-cache');
fs.mkdirSync(artifactsDir, {recursive: true});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-real-editors-'));
const report = {extensionDir, profileDir, evidence: 'Production extension; real editors from esm.sh/jsdelivr; deterministic mock provider', editors: [], consoleErrors: [], slateFastCache, slateRepetitions: []};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const TRANSLATION = 'Let us meet tomorrow afternoon.';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Real editors</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css">
<style>body{font:16px system-ui;padding:24px;max-width:900px;margin:auto}section{margin:18px 0}.box{border:1px solid #ccc;border-radius:8px;padding:8px;min-height:40px}.ProseMirror,#lexical,[data-slate-editor],.public-DraftEditor-content{outline:none;white-space:pre-wrap}</style>
<script src="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js"></script></head><body>
<section><h3>Quill</h3><div id="quill"></div></section>
<section><h3>ProseMirror</h3><div id="pm" class="box"></div></section>
<section><h3>Lexical</h3><div id="lexical" class="box" contenteditable="true"></div></section>
<section><h3>Slate</h3><div id="slate" class="box"></div></section>
<section><h3>Draft.js</h3><div id="draft" class="box"></div></section>
<script type="module">
window.models = {};
window.ready = {};
const quill = new Quill('#quill', {theme: 'snow'});
quill.setText('Quill 富文本原文。');
window.models.quill = () => quill.getText().replace(/\\n$/, '');
window.ready.quill = true;

const [{EditorState}, {EditorView}, {schema}, {history, undo}, {keymap}] = await Promise.all([
  import('https://esm.sh/prosemirror-state@1.4.3'),
  import('https://esm.sh/prosemirror-view@1.38.1'),
  import('https://esm.sh/prosemirror-schema-basic@1.2.3'),
  import('https://esm.sh/prosemirror-history@1.4.1'),
  import('https://esm.sh/prosemirror-keymap@1.2.2'),
]);
const pmDoc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('ProseMirror 富文本原文。')])]);
const view = new EditorView(document.querySelector('#pm'), {state: EditorState.create({doc: pmDoc, plugins: [history(), keymap({'Mod-z': undo})]})});
window.models.pm = () => view.state.doc.textContent;
window.ready.pm = true;

const lexical = await import('https://esm.sh/lexical@0.28.0');
const {registerRichText} = await import('https://esm.sh/@lexical/rich-text@0.28.0?deps=lexical@0.28.0');
const {registerHistory, createEmptyHistoryState} = await import('https://esm.sh/@lexical/history@0.28.0?deps=lexical@0.28.0');
const lex = lexical.createEditor({namespace: 'fixture', onError: error => { throw error; }});
lex.setRootElement(document.querySelector('#lexical'));
registerRichText(lex);
registerHistory(lex, createEmptyHistoryState(), 300);
lex.update(() => {
  const paragraph = lexical.$createParagraphNode();
  paragraph.append(lexical.$createTextNode('Lexical 富文本原文。'));
  lexical.$getRoot().clear().append(paragraph);
}, {discrete: true});
window.models.lexical = () => lex.getEditorState().read(() => lexical.$getRoot().getTextContent());
window.ready.lexical = true;

const React = (await import('https://esm.sh/react@18.3.1')).default;
const {createRoot} = await import('https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1');
const {createEditor, Node: SlateNode} = await import('https://esm.sh/slate@0.112.0');
const {Slate, Editable, withReact} = await import('https://esm.sh/slate-react@0.112.0?deps=react@18.3.1,react-dom@18.3.1,slate@0.112.0');
const slateEditor = withReact(createEditor());
const slateValue = [{type: 'paragraph', children: [{text: 'Slate 富文本原文。'}]}];
createRoot(document.querySelector('#slate')).render(React.createElement(Slate, {editor: slateEditor, initialValue: slateValue},
  React.createElement(Editable, {placeholder: 'Message #general'})));
window.models.slate = () => slateEditor.children.map(node => SlateNode.string(node)).join('\\n');
window.slateDebug = slateEditor;
window.ready.slate = true;

const Draft = await import('https://esm.sh/draft-js@0.11.7?deps=react@18.3.1,react-dom@18.3.1');
let draftState = Draft.EditorState.createWithContent(Draft.ContentState.createFromText('Draft.js 富文本原文。'));
let setDraftExternal;
function DraftFixture() {
  const [state, setState] = React.useState(draftState);
  setDraftExternal = setState;
  draftState = state;
  return React.createElement(Draft.Editor, {editorState: state, onChange: next => { draftState = next; setState(next); }});
}
createRoot(document.querySelector('#draft')).render(React.createElement(DraftFixture));
window.models.draft = () => draftState.getCurrentContent().getPlainText();
window.ready.draft = true;
</script></body></html>`;

const EDITORS = [
  {name: 'quill', selector: '#quill .ql-editor', original: 'Quill 富文本原文。'},
  {name: 'pm', selector: '#pm .ProseMirror', original: 'ProseMirror 富文本原文。'},
  {name: 'lexical', selector: '#lexical', original: 'Lexical 富文本原文。'},
  {name: 'slate', selector: '#slate [data-slate-editor]', original: 'Slate 富文本原文。'},
  {name: 'draft', selector: '#draft .public-DraftEditor-content', original: 'Draft.js 富文本原文。'},
];

let session;
async function main() {
  let launchAttempted = false;
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
    await worker.evaluate((result) => {
      globalThis.inputTest = {requests: []};
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.protocol === 'chrome-extension:') return originalFetch(input, init);
        const body = JSON.parse(init?.body || '{}');
        globalThis.inputTest.requests.push({url: url.href, body});
        return new Response(JSON.stringify({id: 'x', object: 'chat.completion', created: 1, model: body.model,
          choices: [{index: 0, message: {role: 'assistant', content: result}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}), {status: 200, headers: {'content-type': 'application/json'}});
      };
    }, TRANSLATION);
    const options = await helper.newPageWithoutForeground(context);
    await options.goto(`chrome-extension://${extensionId}/options.html#settings-translation`);
    await options.locator('.settings-section').first().waitFor({state: 'attached'});
    const result = await options.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const current = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      const updates = {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, useCache: false,
        inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationTarget: 'en', inputBoxTranslationInterval: 600,
        inputBoxTranslationService: 'openai', inputBoxTranslationModel: 'gpt-4.1-mini',
        requireApiKey: {...current.requireApiKey, 'v2:["openai","gpt-4.1-mini"]': false},
        proxy: {...current.proxy, openai: 'http://127.0.0.1:11434/v1/chat/completions'},
        hotkey: 'disabled', selectionTranslatorMode: 'disabled', floatingBallPosition: 'disabled', translationMaxRetries: 0};
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
        expected: Object.fromEntries(Object.keys(updates).map(key => [key, current[key]])),
        clientId: 'real-editors', sequence: 1, baseRevision: current.__fluentConfigRevision});
    });
    assert.equal(result.success, true, JSON.stringify(result));
    await pause(500);

    await context.route('https://rich-editors.example/**', route => route.fulfill({status: 200, contentType: 'text/html', body: html}));
    const page = await helper.newPageWithoutForeground(context);
    if (slateFastCache) {
      await page.addInitScript(() => {
        window.slateInputEvents = [];
        for (const type of ['beforeinput', 'paste', 'selectionchange']) {
          for (const capture of [true, false]) {
            document.addEventListener(type, event => {
              const editor = document.querySelector('#slate [data-slate-editor]');
              if (!editor || (type === 'selectionchange' ? document.activeElement !== editor : !editor.contains(event.target))) return;
              window.slateInputEvents.push({type, capture, time: performance.now(), inputType: event.inputType,
                defaultPrevented: event.defaultPrevented, targetRanges: event.getTargetRanges?.().length,
                dataTransferText: event.dataTransfer?.getData('text/plain'),
                model: window.models?.slate(), modelSelection: structuredClone(window.slateDebug?.selection),
                domSelection: String(document.getSelection()), dom: editor.innerText});
            }, {capture});
          }
        }
      });
    }
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto('https://rich-editors.example/test');
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    await page.waitForFunction(() => window.ready?.draft === true, undefined, {timeout: 60000});
    await pause(800);
    await helper.activateExtensionTabWithoutForeground(context, page);
    const domSession = await context.newCDPSession(page);

    async function clickRestore() {
      const buttons = [];
      const collect = node => {
        if (node.nodeName === 'BUTTON' && (node.children || []).some(child => child.nodeValue === '恢复原文')) buttons.push(node);
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) collect(child);
      };
      collect((await domSession.send('DOM.getDocument', {depth: -1, pierce: true})).root);
      assert.ok(buttons.length, 'restore action available');
      const quad = (await domSession.send('DOM.getBoxModel', {backendNodeId: buttons.at(-1).backendNodeId})).model.content;
      await page.mouse.click((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    }

    for (const editor of EDITORS) {
      const entry = {name: editor.name};
      report.editors.push(entry);
      try {
        const requestsBefore = (await worker.evaluate(() => globalThis.inputTest.requests.length));
        await page.locator(editor.selector).click();
        await pause(150);
        for (let i = 0; i < 3; i++) { await page.keyboard.press('='); await pause(80); }
        await page.waitForFunction(({name, text}) => window.models[name]().trim() === text, {name: editor.name, text: TRANSLATION}, {timeout: 15000});
        await pause(300);
        entry.model = await page.evaluate(name => window.models[name](), editor.name);
        entry.dom = await page.locator(editor.selector).evaluate(el => el.innerText);
        const requests = await worker.evaluate(() => globalThis.inputTest.requests);
        entry.requestCount = requests.length - requestsBefore;
        const sent = JSON.stringify(requests.at(-1).body);
        entry.sourceSent = sent.includes(editor.original) && !sent.includes('==' + editor.original) && !sent.includes(editor.original + '==');
        assert.equal(entry.model.trim(), TRANSLATION, 'editor model holds exactly the translation (no duplication)');
        assert.equal(entry.dom.trim(), TRANSLATION, 'rendered editor holds exactly the translation');
        assert.equal(entry.requestCount, 1);
        assert.ok(entry.sourceSent, `source sent without trigger symbols: ${sent}`);
        await page.screenshot({caret: 'initial', path: path.join(artifactsDir, `${editor.name}-translated.png`)});

        await pause(400);
        await clickRestore();
        await page.waitForFunction(({name, text}) => window.models[name]().trim() === text, {name: editor.name, text: editor.original}, {timeout: 15000});
        entry.restoredModel = await page.evaluate(name => window.models[name](), editor.name);
        entry.restoredDom = await page.locator(editor.selector).evaluate(el => el.innerText);
        assert.equal(entry.restoredModel.trim(), editor.original, 'original editor model restored');
        assert.equal(entry.restoredDom.trim(), editor.original, 'original rendered editor restored');
        entry.passed = true;
      } catch (error) {
        entry.passed = false;
        entry.error = String(error.message || error).slice(0, 600);
        entry.model ??= await page.evaluate(name => window.models[name](), editor.name).catch(() => null);
        await page.screenshot({caret: 'initial', path: path.join(artifactsDir, `${editor.name}-failed.png`)}).catch(() => undefined);
      }
    }
    if (slateFastCache && report.editors.find(entry => entry.name === 'slate')?.passed) {
      const editor = EDITORS.find(entry => entry.name === 'slate');
      // 前三轮为即时供应商返回，后两轮启用真实 broker cache；最后一轮必须没有 fetch。
      for (let cycle = 0; cycle < 5; cycle++) {
        const entry = {cycle: cycle + 1, cacheEnabled: cycle >= 3};
        report.slateRepetitions.push(entry);
        try {
          if (cycle === 3) {
            report.slateCacheConfig = await options.evaluate(async () => {
              const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
              const current = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
              return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: {useCache: true},
                expected: {useCache: current.useCache}, clientId: 'real-editors', sequence: 2,
                baseRevision: current.__fluentConfigRevision});
            });
            assert.equal(report.slateCacheConfig.success, true, JSON.stringify(report.slateCacheConfig));
          }
          const requestsBefore = await worker.evaluate(() => globalThis.inputTest.requests.length);
          entry.sourceBefore = await page.evaluate(() => ({model: window.models.slate(),
            selection: structuredClone(window.slateDebug.selection), domSelection: String(document.getSelection())}));
          assert.equal(entry.sourceBefore.model, editor.original, 'entire original Slate model before each repetition');
          await page.locator(editor.selector).click();
          for (let i = 0; i < 3; i++) await page.keyboard.press('=');
          await page.waitForFunction(text => window.models.slate() === text, TRANSLATION, {timeout: 15000});
          entry.model = await page.evaluate(() => window.models.slate());
          entry.dom = await page.locator(editor.selector).evaluate(el => el.innerText);
          const requests = await worker.evaluate(() => globalThis.inputTest.requests);
          entry.requestCount = requests.length - requestsBefore;
          assert.equal(entry.model, TRANSLATION, 'exact whole Slate model replaces the original');
          assert.equal(entry.dom, TRANSLATION, 'Slate model and DOM agree');
          assert.equal(entry.requestCount, cycle === 4 ? 0 : 1,
            cycle === 4 ? 'second cached repetition performs zero provider fetches' : 'one immediate provider fetch');
          entry.cacheHit = cycle === 4 && entry.requestCount === 0;
          if (entry.requestCount) {
            const sent = JSON.stringify(requests.at(-1).body);
            entry.sourceSent = sent.includes(editor.original) && !sent.includes(editor.original + '==');
            assert.ok(entry.sourceSent, `source sent without trigger symbols: ${sent}`);
          }
          await clickRestore();
          await page.waitForFunction(text => window.models.slate() === text, editor.original, {timeout: 15000});
          entry.restoredModel = await page.evaluate(() => window.models.slate());
          entry.restoredDom = await page.locator(editor.selector).evaluate(el => el.innerText);
          assert.equal(entry.restoredModel, editor.original, 'exact original Slate model restored');
          assert.equal(entry.restoredDom, editor.original, 'restored Slate model and DOM agree');
          entry.passed = true;
        } catch (error) {
          entry.passed = false;
          entry.error = String(error.message || error).slice(0, 800);
          entry.model ??= await page.evaluate(() => window.models.slate()).catch(() => null);
          entry.dom ??= await page.locator(editor.selector).evaluate(el => el.innerText).catch(() => null);
          await page.screenshot({caret: 'initial', path: path.join(artifactsDir, `slate-repeat-${cycle + 1}-failed.png`)}).catch(() => undefined);
          break;
        }
      }
    }
    if (slateFastCache) {
      report.slateInputEvents = await page.evaluate(() => window.slateInputEvents);
      report.slateSummary = {rounds: report.slateRepetitions.length,
        passed: report.slateRepetitions.filter(entry => entry.passed).length,
        providerRequests: report.slateRepetitions.reduce((sum, entry) => sum + (entry.requestCount || 0), 0),
        cacheHits: report.slateRepetitions.filter(entry => entry.cacheHit).length};
      await page.screenshot({caret: 'initial', path: path.join(artifactsDir, 'slate-repetition-final.png')});
    }
    assert.deepEqual(report.consoleErrors, []);
    report.completed = report.editors.every(entry => entry.passed)
      && (!slateFastCache || (report.slateRepetitions.length === 5 && report.slateRepetitions.every(entry => entry.passed)));
    assert.ok(report.completed, `all editor scenarios pass: ${JSON.stringify({editors: report.editors, slateRepetitions: report.slateRepetitions})}`);
  } finally {
    try {
      fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    } finally {
      if (session) {
        await session.close();
        fs.rmSync(profileDir, {recursive: true, force: true});
      } else if (!launchAttempted) {
        try {fs.rmdirSync(profileDir);} catch { /* No browser launch was attempted; only remove an empty initial profile. */ }
      }
    }
  }
}
main().catch(error => {
  report.fatal = error.stack;
  fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error);
  process.exitCode = 1;
});
