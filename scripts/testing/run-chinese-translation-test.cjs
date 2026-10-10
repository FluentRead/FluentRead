#!/usr/bin/env node
'use strict';

// --target-release 验证 GitHub 发布说明中英技术混排；中文简繁、--spanish 西班牙语、--wrong-language 错语种恢复、--multilingual-same-target 多语言同目标及 --technical-pr-906 技术中文生产浏览器回归：临时 Edge、无前台焦点启动、真实配置选择和真实快捷键。
// 默认同时验证截图中文零请求、相邻外语正常翻译和动态评论换语言后的重新识别。
// loopback AI fixture 只验证请求与 UI 链路；--live-google 独立报告无需凭据的外部服务实译。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const chinesePosts = require('../../tests/fixtures/chinese-language-posts.json');
const modelPost = require('../../tests/fixtures/chinese-language-model-post.json');
const {multilingualFixtureTranslation, renderMultilingualPage, runMultilingualSameTargetCases} = require('./multilingual-same-target-browser.cjs');
const multilingualMode = process.argv.includes('--multilingual-same-target');
const releaseTargetMode = process.argv.includes('--target-release');
const technicalPr906Mode = releaseTargetMode || process.argv.includes('--technical-pr-906');
const technicalSourceUrl = releaseTargetMode ? 'https://github.com/FluentRead/FluentRead/releases' : 'https://github.com/FluentRead/FluentRead/pull/906';
const technicalArtifactLabel = releaseTargetMode ? 'target-language-release' : 'technical-pr-906';
const technicalPr906Posts = technicalPr906Mode ? require(releaseTargetMode
  ? '../../tests/fixtures/target-language-releases.json' : '../../tests/fixtures/chinese-technical-pr-906.json') : [];
if (technicalPr906Mode) {
  assert(!process.argv.some(argument => ['--multilingual-same-target', '--wrong-language', '--spanish', '--excluded-languages', '--live-google'].includes(argument)),
    '--technical-pr-906 必须单独运行，不能隐式扩大专项范围');
  assert.equal(technicalPr906Posts.length, releaseTargetMode ? 10 : 4, '技术中文夹具必须保留受测原文');
}
const wrongLanguageMode = process.argv.includes('--wrong-language');
const wrongLanguageResult = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
const releaseNote = '云端模型清单允许清空，且不再连带拒掉无关偏好的保存';
const sameLanguageTexts = [
  ...chinesePosts,
  '✨ 新增功能',
  '新增文档翻译工作台，支持 PDF、ePub、DOCX，以及 HTML、TXT、Markdown、SRT、VTT、ASS/SSA、LRC、JSON 等格式。',
  ...modelPost,
  modelPost.join('\n'),
  releaseNote,
  `${releaseNote} (84522b3)`,
];

const paragraphs = {
  en: [
    'This software reads the document and translates the language on this page.',
    'The second paragraph explains the settings for the computer network.',
  ],
  'zh-Hans': [
    '这个软件读取文档并翻译这个页面上的语言。',
    '第二个段落说明计算机网络的设置。',
  ],
  'zh-Hant': [
    '這個軟體讀取文件並翻譯這個頁面上的語言。',
    '第二個段落說明電腦網路的設定。',
  ],
};
paragraphs.es = [
  'Este programa lee el documento y traduce el idioma de esta página.',
  'El segundo párrafo explica la configuración de la red informática.',
];
const fixtureTitles = {
  en: 'Chinese script translation fixture',
  'zh-Hans': '中文书写体系测试页面',
  'zh-Hant': '中文書寫體系測試頁面',
  es: 'Prueba de escritura china',
};
const spanishMode = process.argv.includes('--spanish');
const pairs = spanishMode ? [
  {from: 'es', to: 'zh-Hans'},
  {from: 'es', to: 'zh-Hant'},
  {from: 'zh-Hans', to: 'es'},
  {from: 'zh-Hant', to: 'es'},
] : [
  {from: 'en', to: 'zh-Hans'},
  {from: 'en', to: 'zh-Hant'},
  {from: 'zh-Hans', to: 'zh-Hant'},
  {from: 'zh-Hant', to: 'zh-Hans'},
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
function matchesSubset(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual && typeof actual === 'object'
      && Object.entries(expected).every(([key, value]) => matchesSubset(actual[key], value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function fixtureTranslation(source, target) {
  if (source === fixtureTitles.en || source === 'Same-language comments') return fixtureTitles[target];
  let matched = false;
  let result = source;
  for (const sentences of Object.values(paragraphs)) {
    sentences.forEach((sentence, index) => {
      if (result.includes(sentence)) {
        matched = true;
        result = result.replaceAll(sentence, paragraphs[target][index]);
      }
    });
  }
  assert(matched, `fixture 收到未知原文：${source}`);
  return result;
}
function escapeHtml(value) {
  return value.replace(/[&<>"]/gu, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[character]);
}
function renderTechnicalPr906Page(markup) {
  assert(['plain', 'split'].includes(markup), '未知 PR #906 夹具结构');
  const posts = technicalPr906Posts.map((text, index) => {
    let ordinal = 0;
    let cursor = 0;
    let content = '';
    if (markup === 'split') {
      // 先分词再转义，避免把 && 的 &amp; 实体拆进行内标签而改变原文。
      for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:[ +→][A-Za-z][A-Za-z0-9_]*)*/gu)) {
        const tag = ordinal++ % 2 ? 'strong' : 'code';
        content += escapeHtml(text.slice(cursor, match.index)) + `<${tag}>${escapeHtml(match[0])}</${tag}>`;
        cursor = match.index + match[0].length;
      }
      content += escapeHtml(text.slice(cursor));
    } else content = escapeHtml(text);
    return `<p data-technical="${index}">${content}</p>`;
  }).join('');
  // 宿主页故意声明英文；以局部正文而非整页语言判断中文，并覆盖普通文本和行内代码/强调结构。
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>技术中文语言识别回归</title></head>`
    + `<body style="padding:24px;font:18px/1.7 sans-serif"><main>${posts}`
    + `<p id="english-control">${paragraphs.en[0]}</p><p id="dynamic-comment">${escapeHtml(technicalPr906Posts[0])}</p>`
    + '</main></body></html>';
}
function technicalPr906Translation(source, target) {
  if (target === 'zh-Hans') {
    if (!releaseTargetMode || paragraphs.en.some(text => source.includes(text))) return fixtureTranslation(source, target);
    const translated = '这个页面说明软件的功能和设置。';
    const slotted = source.replace(/(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/gu,
      (_match, begin, _nonce, _index, _content, end) => `${begin}${translated}${end}`);
    return slotted === source ? translated : slotted;
  }
  assert.equal(target, 'en', 'PR #906 专项只测试简体中文与英文目标');
  const translated = 'The production test validates the translation controls for the current paragraph.';
  if (source.startsWith('___FLUENTREAD_')) {
    return source.replace(/(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/gu,
      (_match, begin, _nonce, _index, _content, end) => `${begin}${translated}${end}`);
  }
  return translated;
}
function assertScript(text, target) {
  assert(text.trim(), '译文不能为空');
  // 样例包含多个稳定区分字，不把所有汉字直接判作简体或繁体。
  if (target === 'es') {
    assert(!/\p{Script=Han}/u.test(text), `西班牙语译文保留了中文：${text}`);
    assert(/(?:programa|software|documento|párrafo|configuración|red)/iu.test(text), `缺少西班牙语证据：${text}`);
  } else if (target === 'zh-Hans') {
    assert(/[这读译页语个说计机网设]/u.test(text), `缺少简体证据：${text}`);
    assert(!/[這讀譯頁語個說計機網設]/u.test(text), `简体译文混入繁体：${text}`);
  } else {
    assert(/[這讀譯頁語個說計機網設]/u.test(text), `缺少繁体证据：${text}`);
    assert(!/[这读译页语个说计机网设]/u.test(text), `繁体译文混入简体：${text}`);
  }
}
async function startFixture() {
  const requests = [];
  let sentWrongLanguage = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
        const targetName = /TARGET_BEGIN([\s\S]*?)TARGET_END/u.exec(prompt)?.[1];
        const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
        assert.equal(typeof source, 'string', '实际模板必须包含原文');
        if (technicalPr906Mode) {
          const target = /\bzh-Hans\b/u.test(targetName || '') ? 'zh-Hans' : /\ben\b/u.test(targetName || '') ? 'en' : undefined;
          const entry = {source, target, targetName, prompt};
          requests.push(entry);
          entry.translated = technicalPr906Translation(source, target);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({id: 'technical-pr-906-fixture', object: 'chat.completion', created: 1,
            model: 'chinese-script-fixture', choices: [{index: 0, message: {role: 'assistant', content: entry.translated}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 20, completion_tokens: 20, total_tokens: 40}}));
          return;
        }
        if (multilingualMode) {
          // 多语言专项接受任意目录目标，按确定性标记回填；先记录请求再响应，任何同目标泄漏都会被计数。
          const entry = {source, targetName, prompt};
          requests.push(entry);
          entry.translated = multilingualFixtureTranslation(source, targetName);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({id: 'multilingual-fixture', object: 'chat.completion', created: 1,
            model: 'chinese-script-fixture', choices: [{index: 0, message: {role: 'assistant', content: entry.translated}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 20, completion_tokens: 20, total_tokens: 40}}));
          return;
        }
        const target = targetName === 'es' ? 'es' : /\bzh-(Hans|Hant)\b/u.exec(targetName || '')?.[0];
        assert(target, `{{to}} 未传入受测目标语言：${targetName}`);
        assert(target === 'es' || targetName.includes(target === 'zh-Hans' ? 'Simplified Chinese' : 'Traditional Chinese'),
          '{{to}} 必须包含模型可理解的中文书写体系名称');
        // 先记录到达端点的请求，未知原文被夹具拒绝也必须计数，避免漏检无效请求。
        const entry = {source, target, targetName, prompt};
        requests.push(entry);
        let translated = fixtureTranslation(source, target);
        if (wrongLanguageMode && !sentWrongLanguage && target === 'zh-Hans' && source.includes(paragraphs.en[0])) {
          sentWrongLanguage = true;
          translated = wrongLanguageResult;
        }
        entry.translated = translated;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({id: 'chinese-script-fixture', object: 'chat.completion', created: 1,
          model: 'chinese-script-fixture', choices: [{index: 0, message: {role: 'assistant', content: translated}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 20, completion_tokens: 20, total_tokens: 40}}));
      } catch (error) {
        response.writeHead(400); response.end(JSON.stringify({error: {message: error.message}}));
      }
      return;
    }
    const url = new URL(request.url, 'http://fixture.local');
    const source = url.searchParams.get('source') || 'en';
    if (source === 'technical-pr-906') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(renderTechnicalPr906Page(url.searchParams.get('markup') || 'plain'));
      return;
    }
    if (source === 'same-language') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 故意沿用英文页面语言，证明每条评论按原文判断，而非信任宿主整页语言。
      const comments = sameLanguageTexts.map((text, index) => text.endsWith('(84522b3)')
        ? `<ul><li data-same-language="${index}">${releaseNote} (<a href="https://github.com/solidSpoon/DashPlayer/commit/84522b3ff33401f87da8d5d7c4510ea5453e40ef">84522b3</a>)</li></ul>`
        : `<article><p data-same-language="${index}">${text}</p></article>`).join('');
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Same-language comments</title></head><body style="padding:24px;font:18px/1.6 sans-serif"><main>${comments}<p id="english-control">${paragraphs.en[0]}</p><p id="traditional-control">${paragraphs['zh-Hant'][0]}</p></main></body></html>`);
      return;
    }
    if (source === 'multilingual') {
      const html = renderMultilingualPage(url.searchParams.get('target'));
      if (!html) {response.writeHead(404); response.end(); return;}
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    if (source === 'excluded-languages') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${paragraphs['zh-Hant'][0]}</title></head><body style="padding:32px;font:20px/1.8 sans-serif"><main><p id="traditional-control">${paragraphs['zh-Hant'][0]}</p><p id="english-control">${paragraphs.en[0]}</p><p id="japanese-control">これは日本語の説明です。</p></main></body></html>`);
      return;
    }
    const texts = paragraphs[source];
    if (!texts) {response.writeHead(404); response.end(); return;}
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="${source}"><head><meta charset="utf-8"><title>Chinese script translation fixture</title></head><body style="padding:64px;font:22px/1.8 sans-serif"><main><p id="chinese-primary">${texts[0]}</p><p id="chinese-neighbor">${texts[1]}</p></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(resolve => server.close(resolve))};
}

async function runTechnicalPr906Cases({context, createPage, patchConfig, activateExtensionTabWithoutForeground, shot, report, fixture, artifactsDir}) {
  report.scope = `${technicalSourceUrl}: ${technicalPr906Posts.length} technical Chinese paragraphs, plain and code/strong inline DOM, Simplified Chinese hover/full zero requests and zero wrappers, English neighbor restore/retranslate, dynamic Chinese-to-English mutation, target switch to English`;
  report.technicalPr906 = {source: technicalSourceUrl, paragraphs: technicalPr906Posts.length, cases: []};
  for (const markup of ['plain', 'split']) {
    await patchConfig({from: 'auto', to: 'zh-Hans', useCache: false, excludedLanguages: [], pageTitleTranslationEnabled: false});
    const page = await createPage(`${fixture.url}/article?source=technical-pr-906&markup=${markup}`, `${technicalArtifactLabel}-${markup}`);
    const caseReport = {markup, status: 'running'};
    report.technicalPr906.cases.push(caseReport);
    try {
      await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
      const initialUrl = page.url();
      const selectors = technicalPr906Posts.map((_, index) => `[data-technical="${index}"]`);
      const originalHtml = await Promise.all(selectors.map(selector => page.locator(selector).innerHTML()));
      assert.deepEqual(await page.locator('[data-technical]').allTextContents(), technicalPr906Posts);
      if (markup === 'split') {
        assert(await page.locator('[data-technical] code').count() > 0, '拆分夹具必须包含行内代码');
        assert(await page.locator('[data-technical] strong').count() > 0, '拆分夹具必须包含强调片段');
      }
      const wrappers = selector => page.locator(`${selector} .fluent-read-bilingual-content`).count();
      const hover = async selector => {
        await activateExtensionTabWithoutForeground(context, page, 30000);
        const element = page.locator(selector);
        await element.click({position: {x: 4, y: 4}}); await element.hover({position: {x: 4, y: 4}});
        await page.keyboard.down('Control'); await page.keyboard.up('Control');
      };
      const full = async () => {
        await activateExtensionTabWithoutForeground(context, page, 30000);
        await page.locator('main').click({position: {x: 2, y: 2}});
        await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
      };
      const start = fixture.requests.length;
      const assertRetained = async () => {
        assert.equal(page.url(), initialUrl);
        assert.equal(await page.locator('[data-technical] .fluent-read-bilingual-content').count(), 0, '同目标技术中文不能插入译文');
        assert.deepEqual(await page.locator('[data-technical]').allTextContents(), technicalPr906Posts);
        assert.deepEqual(await Promise.all(selectors.map(selector => page.locator(selector).innerHTML())), originalHtml, '中文原始行内 DOM 必须保留');
        assert.equal(await page.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
        // 标准段落以外的任何请求（包括只含英文标识符的拆分槽）均属于泄漏。
        const leaked = fixture.requests.slice(start).filter(request => !paragraphs.en.some(text => request.source.includes(text)));
        assert.deepEqual(leaked.map(request => request.source), [], '同目标技术中文及拆分槽不得进入翻译请求');
      };
      for (const selector of selectors) {
        await hover(selector); await wait(400); await assertRetained();
      }
      assert.equal(fixture.requests.length, start, '技术中文悬浮必须零请求');
      caseReport.sameTargetHoverRequests = 0;
      caseReport.sameTargetWrappers = 0;
      const hoverCounts = [];
      for (const expected of [1, 0, 1, 0]) {
        await hover('#english-control');
        await page.waitForFunction(expected => document.querySelectorAll('#english-control .fluent-read-bilingual-content').length === expected, expected);
        hoverCounts.push(await wrappers('#english-control'));
        if (expected) assert.equal((await page.locator('#english-control .fluent-read-bilingual-content').innerText()).trim(), paragraphs['zh-Hans'][0]);
        else assert.equal(await page.locator('#english-control').innerText(), paragraphs.en[0]);
        await assertRetained();
      }
      caseReport.foreignHoverCounts = hoverCounts;
      const fullCounts = [];
      for (const expected of [1, 0, 1]) {
        await full();
        await page.waitForFunction(expected => document.querySelectorAll('#english-control .fluent-read-bilingual-content').length === expected, expected);
        await wait(400);
        fullCounts.push(await wrappers('#english-control'));
        assert.equal(await wrappers('#dynamic-comment'), 0);
        await assertRetained();
      }
      caseReport.foreignFullPageCounts = fullCounts;
      caseReport.sameTargetFullRequests = 0;
      const beforeDynamic = fixture.requests.length;
      await page.locator('#dynamic-comment').evaluate((element, text) => {element.textContent = text;}, paragraphs.en[1]);
      await page.locator('#dynamic-comment .fluent-read-bilingual-content').waitFor({state: 'visible'});
      assert(fixture.requests.slice(beforeDynamic).some(request => request.source.includes(paragraphs.en[1])), '动态中文改成英文后必须重新请求');
      assert.equal((await page.locator('#dynamic-comment .fluent-read-bilingual-content').innerText()).trim(), paragraphs['zh-Hans'][1]);
      await assertRetained();
      caseReport.dynamicRedetection = true;
      caseReport.sameTargetRequestSources = fixture.requests.slice(start).map(request => request.source);
      await shot(page, `${technicalArtifactLabel}-${markup}-retained`, {fullPage: true});
      fs.writeFileSync(path.join(artifactsDir, `${technicalArtifactLabel}-${markup}-retained.html`), await page.content());
      await full();
      await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0);
      assert.equal(await page.locator('#dynamic-comment').innerText(), paragraphs.en[1]);
      await assertRetained();
      caseReport.restored = true;
      await patchConfig({to: 'en'}); await wait(300);
      const switchStart = fixture.requests.length;
      await full();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-technical]')).every(element =>
        element.querySelectorAll('.fluent-read-bilingual-content').length === 1));
      await wait(400);
      assert.equal(await wrappers('#english-control'), 0, '英文目标下英文相邻段落必须保留');
      assert.equal(await wrappers('#dynamic-comment'), 0, '英文目标下动态英文必须保留');
      assert(fixture.requests.slice(switchStart).some(request => /\p{Script=Han}/u.test(request.source)), '英文目标下中文原文必须请求');
      assert(!fixture.requests.slice(switchStart).some(request => paragraphs.en.some(text => request.source.includes(text))), '英文目标下不得请求英文正文');
      assert.equal(await page.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
      assert.equal(page.url(), initialUrl);
      caseReport.targetSwitch = {from: 'zh-Hans', to: 'en', translatedChineseParagraphs: technicalPr906Posts.length, requestCount: fixture.requests.length - switchStart};
      await shot(page, `${technicalArtifactLabel}-${markup}-english-target`, {fullPage: true});
      fs.writeFileSync(path.join(artifactsDir, `${technicalArtifactLabel}-${markup}-english-target.html`), await page.content());
      await full();
      await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0);
      assert.deepEqual(await Promise.all(selectors.map(selector => page.locator(selector).innerHTML())), originalHtml);
      caseReport.targetSwitchRestored = true;
      caseReport.urlStable = true;
      caseReport.originalInlineDomPreserved = true;
      caseReport.status = 'passed';
    } catch (error) {
      caseReport.status = 'failed'; caseReport.error = error.stack || String(error);
      await shot(page, `${technicalArtifactLabel}-${markup}-failure`).catch(() => {});
      fs.writeFileSync(path.join(artifactsDir, `${technicalArtifactLabel}-${markup}-failure.html`), await page.content().catch(() => ''));
      throw error;
    } finally {await page.close();}
  }
}

async function runLiveTargetReleaseCase({context, createPage, patchConfig, activateExtensionTabWithoutForeground, shot, report, fixture, artifactsDir}) {
  await patchConfig({from: 'auto', to: 'zh-Hans', useCache: false, excludedLanguages: [], pageTitleTranslationEnabled: false});
  const page = await createPage(technicalSourceUrl, 'live-target-language-release');
  const live = {url: technicalSourceUrl, provider: 'loopback-fixture', status: 'running', cases: []};
  report.liveRelease = live;
  try {
    await page.locator('.markdown-body').first().waitFor({state: 'visible', timeout: 45000});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const needles = ['拒绝扩展包的打包兼容问题', '翻译语言扩展至 52 种', '漫画重运算移入 Worker', 'Thunderbird 邮件翻译',
      '另附 Firefox 构建源码', 'Google Meet', 'YouTube、Udemy、Disney+', '多个 API Key'];
    const matches = await page.locator('.markdown-body p, .markdown-body li').evaluateAll((elements, needles) =>
      needles.map((needle, probe) => {
        const index = elements.findIndex(element => (element.textContent || '').includes(needle)
          && /\p{Script=Han}/u.test(element.textContent || ''));
        if (index >= 0) elements[index].setAttribute('data-fr-target-language-probe', String(probe));
        return {needle, index, probe, source: index < 0 ? '' : elements[index].textContent.trim()};
      }), needles);
    assert(matches.every(item => item.index >= 0), '真实发布页面必须找到截图中的所有中文段落');
    const originalUrl = page.url();
    const start = fixture.requests.length;
    for (const match of matches) {
      const element = page.locator(`[data-fr-target-language-probe="${match.probe}"]`);
      await element.scrollIntoViewIfNeeded();
      await activateExtensionTabWithoutForeground(context, page, 30000);
      await element.click({position: {x: 3, y: 3}}); await element.hover({position: {x: 3, y: 3}});
      await page.keyboard.down('Control'); await page.keyboard.up('Control');
      await wait(450);
      assert.equal(await element.locator('.fluent-read-bilingual-content').count(), 0, `真实中文段落不能插入译文：${match.needle}`);
      assert.equal((await element.textContent()).trim(), match.source);
      live.cases.push({...match, hoverWrappers: 0});
    }
    assert.equal(fixture.requests.length, start, '真实发布页同目标悬浮必须零请求');
    live.hoverRequests = 0;
    await activateExtensionTabWithoutForeground(context, page, 30000);
    await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
    await page.locator('.markdown-body .fluent-read-bilingual-content').first().waitFor({state: 'visible', timeout: 45000});
    await wait(1800);
    for (const match of matches) {
      const element = page.locator(`[data-fr-target-language-probe="${match.probe}"]`);
      assert.equal(await element.locator('.fluent-read-bilingual-content').count(), 0, `真实中文段落全文不能插入译文：${match.needle}`);
      assert.equal((await element.textContent()).trim(), match.source);
    }
    const leaks = fixture.requests.slice(start).filter(request => needles.some(needle => request.source.includes(needle)));
    assert.deepEqual(leaks, [], '截图中文段落及其正文槽不能发出请求');
    live.fullSampleRequests = 0;
    live.foreignWrappers = await page.locator('.markdown-body .fluent-read-bilingual-content').count();
    assert(live.foreignWrappers > 0, '真实页面的英文部分必须仍能翻译');
    await shot(page, 'live-target-language-release', {fullPage: true});
    fs.writeFileSync(path.join(artifactsDir, 'live-target-language-release.html'), await page.content());
    await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
    await page.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0);
    assert.equal(page.url(), originalUrl);
    live.restored = true; live.urlStable = true; live.status = 'passed';
  } catch (error) {
    live.status = 'failed'; live.error = error.stack || String(error);
    await shot(page, 'live-target-language-release-failure').catch(() => {});
    throw error;
  } finally {await page.close();}
}

async function main() {
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const packages = argument('playwright-root');
  const helperPath = argument('focus-safe-helper');
  assert(packages && helperPath, '必须传入 --playwright-root 和 --focus-safe-helper');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), '缺少扩展构建产物');
  const {chromium} = require(path.join(packages, 'playwright'));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-chinese-browser'));
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-chinese-edge-'));
  const fixture = await startFixture();
  const report = {ok: false, extensionDir, artifactsDir, profileDir,
    scope: 'production Popup language selection, persistence, real Control hover and Alt+T full-page [1,0,1], Chinese same-language skipping, dynamic redetection, Chinese script / Spanish output discrimination and target cache isolation',
    evidenceBoundary: 'The local HTML and loopback OpenAI-compatible server are deterministic fixtures. Their success does not prove any external service translation quality or availability.',
    fixture: {ok: false, cases: []}, liveGoogle: {requested: process.argv.includes('--live-google'), cases: []},
    screenshots: [], consoleErrors: [], ui: {}};
  let launched;
  let currentPage;
  let browserSafetyFailure = false;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    const context = launched.context;
    const capture = (surface, source) => {
      surface.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({source, message: message.text()});});
      surface.on('pageerror', error => report.consoleErrors.push({source, message: error.message}));
    };
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    capture(worker, 'worker');
    const extensionOrigin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    const createPage = async (url, name) => {
      const page = await newPageWithoutForeground(context, 30000).catch(error => {
        browserSafetyFailure = true;
        throw error;
      });
      page.setDefaultTimeout(20000); capture(page, name);
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      currentPage = page;
      return page;
    };
    const popup = await createPage(`${extensionOrigin}/popup.html`, 'popup');
    const readConfig = () => popup.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!result?.success) throw new Error(result?.error || '读取配置失败');
      return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    });
    const waitConfig = async predicate => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const value = await readConfig();
        if (value && predicate(value)) return value;
        await wait(50);
      }
      throw new Error('配置未达到预期持久化状态');
    };
    await waitConfig(config => config.to && config.service);
    const patchConfig = async patch => {
      const current = await readConfig();
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const initialCredentials = Object.hasOwn(patch, 'token');
      if (initialCredentials) assert.equal(current.customOpenAIProviders?.length, 0, '合成凭据仅可写入空白临时 profile');
      const result = await popup.evaluate(async ({patch, expected, current, initialCredentials}) => chrome.runtime.sendMessage({
        type: 'persistConfig', mode: initialCredentials ? 'replace' : 'patch',
        config: initialCredentials ? {...current, ...patch} : patch, expected,
        baseRevision: initialCredentials ? current.__fluentConfigRevision : undefined,
        clientId: `chinese-fixture-${crypto.randomUUID()}`, sequence: 1}), {patch, expected, current, initialCredentials});
      assert.equal(result?.success, true, result?.error);
      await waitConfig(config => Object.keys(patch).filter(key => key !== 'token').every(key => matchesSubset(config[key], patch[key])));
    };
    const shot = async (page, name, options = {}) => {
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file, animations: 'disabled', ...options}); report.screenshots.push(file);
    };
    const service = 'custom:chinese-script-fixture';
    await patchConfig({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, service,
      from: 'en', to: 'zh-Hans', display: 1, useCache: true, autoTranslate: false,
      customOpenAIProviders: [{id: service, name: '中文简繁测试服务', endpoint: `${fixture.url}/v1/chat/completions`, models: ['chinese-script-fixture']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'chinese-script-fixture'},
      user_role: {[service]: 'TARGET_BEGIN{{to}}TARGET_END\nSOURCE_BEGIN{{origin}}SOURCE_END'},
      enableAIContext: false, enableAIMultiSegment: false, glossaryEnabled: false,
      hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'all',
      mouseHoverTranslationDelay: 0, selectionTranslatorMode: 'disabled', disableSelectionTranslator: true,
      animations: false});
    if (technicalPr906Mode) {
      report.ui.configuration = {on: true, from: 'auto', to: 'zh-Hans', display: 1, service,
        hotkey: 'Control', floatingBallHotkey: 'Alt+T', useCache: false, fullPageTranslationMode: 'all'};
      await runTechnicalPr906Cases({context, createPage, patchConfig, activateExtensionTabWithoutForeground, shot, report, fixture, artifactsDir});
      if (releaseTargetMode) await runLiveTargetReleaseCase({context, createPage, patchConfig, activateExtensionTabWithoutForeground, shot, report, fixture, artifactsDir});
      report.fixture.cases = report.technicalPr906.cases;
      report.fixture.ok = report.fixture.cases.every(item => item.status === 'passed');
      assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
      assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
      assert.equal(report.windowPlacement.browserFrontmost, false);
      report.ok = report.fixture.ok;
      return;
    }
    if (multilingualMode) {
      report.scope = 'Multilingual same-target skipping: de/pt/it/fr/en/ru/ja/ko/zh-Hans hover and full-page zero requests, neighbor [1,0,1], titles, GitHub commit links, dynamic redetection, target switch and excluded-language parity';
      await runMultilingualSameTargetCases({context, createPage, patchConfig, activateExtensionTabWithoutForeground, shot, report, fixture, artifactsDir});
      report.fixture.ok = report.multilingual.cases.every(item => item.status === 'passed');
      assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
      assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
      assert.equal(report.windowPlacement.browserFrontmost, false);
      report.ok = report.fixture.ok;
      return;
    }
    if (process.argv.includes('--excluded-languages')) {
      report.scope = 'Issue #627: language multiselect, quick close, cross-page persistence, responsive themes, hover/full/automatic skipping, title and dynamic redetection';
      await require('./excluded-languages-browser.cjs')({context, popup, createPage, patchConfig, waitConfig,
        activateExtensionTabWithoutForeground, shot, report, fixture, extensionOrigin, paragraphs});
      report.fixture.ok = true;
      assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
      report.ok = true;
      return;
    }
    await popup.reload({waitUntil: 'domcontentloaded'});
    const sourceSelect = popup.locator('.language-pair .el-select').nth(0);
    const targetSelect = popup.locator('.language-pair .el-select').nth(1);
    await sourceSelect.waitFor({state: 'visible'});
    const labels = {'zh-Hans': '简体中文 /', 'zh-Hant': '繁體中文 /', en: 'English /', es: 'Español /'};
    const choicesFor = async control => {
      await control.click();
      const options = popup.locator('.el-select-dropdown:visible .el-select-dropdown__item');
      await options.first().waitFor({state: 'visible'});
      const choices = (await options.allTextContents()).map(label => ({label,
        value: Object.keys(labels).find(value => label.includes(labels[value]))}));
      await popup.keyboard.press('Escape');
      await popup.locator('.el-select-dropdown:visible').waitFor({state: 'hidden'});
      return choices;
    };
    report.ui.sourceChoices = await choicesFor(sourceSelect);
    report.ui.targetChoices = await choicesFor(targetSelect);
    for (const choices of [report.ui.sourceChoices, report.ui.targetChoices]) {
      assert(choices.some(item => item.value === 'es'));
      assert(choices.some(item => item.value === 'zh-Hans' && item.label.includes('简体中文')));
      assert(choices.some(item => item.value === 'zh-Hant' && item.label.includes('繁體中文')));
    }
    const selectLanguages = async (from, to) => {
      await activateExtensionTabWithoutForeground(context, popup, 30000);
      for (const [control, value] of [[sourceSelect, from], [targetSelect, to]]) {
        await control.click();
        await popup.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({hasText: labels[value]}).click();
        await popup.locator('.el-select-dropdown:visible').waitFor({state: 'hidden'});
      }
      await waitConfig(config => config.from === from && config.to === to);
      await popup.reload({waitUntil: 'domcontentloaded'});
      await sourceSelect.waitFor({state: 'visible'});
      assert((await sourceSelect.innerText()).includes(labels[from]));
      assert((await targetSelect.innerText()).includes(labels[to]));
    };
    await selectLanguages('zh-Hans', 'zh-Hant');
    await shot(popup, 'popup-simplified-to-traditional');
    await selectLanguages('zh-Hant', 'zh-Hans');
    await shot(popup, 'popup-traditional-to-simplified');
    report.ui.languageSelectionPersistence = true;

    const runCase = async (pair, mode, live = false) => {
      await selectLanguages(pair.from, pair.to);
      const name = `${live ? 'google' : 'fixture'}-${pair.from}-${pair.to}-${mode}`;
      const article = await createPage(`${fixture.url}/article?source=${pair.from}&case=${name}`, name);
      const url = article.url();
      try {
        await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
        const primary = article.locator('#chinese-primary');
        const neighbor = article.locator('#chinese-neighbor');
        const beforeText = await primary.innerText();
        const beforeTitle = await article.title();
        assert.equal(beforeText, paragraphs[pair.from][0]);
        const requestStart = fixture.requests.length;
        const counts = [];
        let requestCountAfterFirst;
        let translated = '';
        for (const expected of [1, 0, 1]) {
          await activateExtensionTabWithoutForeground(context, article, 30000);
          if (mode === 'hover') {
            await primary.click(); await primary.hover();
            await article.keyboard.down('Control'); await article.keyboard.up('Control');
          } else {
            await primary.click();
            await article.keyboard.down('Alt'); await article.keyboard.press('t'); await article.keyboard.up('Alt');
          }
          await article.waitForFunction(({expected, mode}) => {
            const count = document.querySelectorAll('#chinese-primary .fluent-read-bilingual-content').length;
            const neighborCount = document.querySelectorAll('#chinese-neighbor .fluent-read-bilingual-content').length;
            return count === expected && neighborCount === (mode === 'full' ? expected : 0);
          }, {expected, mode}, {timeout: live ? 45000 : 20000});
          if (!live && mode === 'full') {
            // 全文也翻译标签页标题；等待标题完成后再检查缓存请求数，不能漏记或
            // 中止一个尚未写入缓存的合法标题请求。
            await article.waitForFunction(title => document.title === title,
              expected ? fixtureTitles[pair.to] : beforeTitle);
          }
          counts.push(await primary.locator('.fluent-read-bilingual-content').count());
          if (expected) {
            const textNodes = primary.locator('.fluent-read-bilingual-content');
            await article.waitForFunction(() => document.querySelector('#chinese-primary .fluent-read-bilingual-content')?.textContent?.trim(), undefined, {timeout: live ? 45000 : 20000});
            translated = await textNodes.innerText();
            assertScript(translated, pair.to);
            if (!live) assert.equal(translated.trim(), paragraphs[pair.to][0]);
            if (mode === 'full') {
              const neighborText = await neighbor.locator('.fluent-read-bilingual-content').innerText();
              assertScript(neighborText, pair.to);
              if (!live) assert.equal(neighborText.trim(), paragraphs[pair.to][1]);
            }
          } else {
            assert.equal(await primary.innerText(), beforeText, '恢复原文必须保留原始文字');
          }
          assert.equal(article.url(), url);
          assert.equal(await article.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
          if (counts.length === 1) requestCountAfterFirst = fixture.requests.length;
        }
        if (!live) {
          assert.equal(fixture.requests.length, requestCountAfterFirst, '重复翻译应命中相同书写体系的缓存');
          assert(fixture.requests.slice(requestStart).every(request => request.target === pair.to), '请求或缓存不能串用另一书写体系');
        }
        await shot(article, name);
        return {...pair, mode, status: 'passed', counts, translated, requestDelta: fixture.requests.length - requestStart,
          sourceRestored: true, urlStable: true, noNestedTranslations: true};
      } catch (error) {
        await shot(article, `${name}-failure`).catch(() => {});
        fs.writeFileSync(path.join(artifactsDir, `${name}-failure.html`), await article.content().catch(() => ''));
        throw error;
      } finally {
        await article.close(); currentPage = popup;
      }
    };
    if (wrongLanguageMode) {
      report.scope = 'Issue #185: production full-page translation retries a clearly Japanese response for a Chinese target, restores, and translates again from cache';
      const result = await runCase({from: 'en', to: 'zh-Hans'}, 'full');
      report.fixture.cases.push(result);
      const attempts = fixture.requests.filter(request => request.source.includes(paragraphs.en[0]));
      assert.equal(attempts.length, 2, '异常段落只应进行一次纠错重试');
      assert.equal(attempts[0].translated, wrongLanguageResult);
      assert.equal(attempts[1].translated, paragraphs['zh-Hans'][0]);
      assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
      assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
      assert.equal(report.windowPlacement.browserFrontmost, false);
      report.wrongLanguage = {attempts: attempts.length, rejectedJapanese: true,
        restored: result.sourceRestored, counts: result.counts, translated: result.translated};
      report.fixture.ok = true;
      report.ok = true;
      return;
    }
    for (const mode of ['hover', 'full']) {
      for (const pair of pairs) report.fixture.cases.push(await runCase(pair, mode));
    }
    // 首次同一原文的两个目标必须分别请求，随后回到简体应复用已保存的简体结果。
    for (const target of ['zh-Hans', 'zh-Hant']) {
      assert(fixture.requests.some(request => request.target === target && request.source.includes(paragraphs[spanishMode ? 'es' : 'en'][0])), `缺少 ${spanishMode ? "es" : "en"} 到 ${target} 的独立请求`);
    }
    const beforeRevisit = fixture.requests.length;
    report.fixture.cacheRevisit = await runCase(pairs[0], 'hover');
    assert.equal(fixture.requests.length, beforeRevisit, '切回简体必须命中简体缓存');
    report.fixture.targetCacheIsolation = true;
    if (!spanishMode) {
      await patchConfig({from: 'auto', to: 'zh-Hans', useCache: false});
      const article = await createPage(`${fixture.url}/?source=same-language`, 'same-language-comments');
      try {
        await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
        await activateExtensionTabWithoutForeground(context, article, 20000);
        const requestStart = fixture.requests.length;
        const originalUrl = article.url();
        const checkOriginals = async () => {
          assert.equal(article.url(), originalUrl);
          assert.equal(await article.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
          assert.equal(await article.locator('[data-same-language] .fluent-read-bilingual-content').count(), 0);
          assert.deepEqual(await article.locator('[data-same-language]').allTextContents(), sameLanguageTexts);
          assert.equal(await article.locator('[data-same-language] a').getAttribute('href'),
            'https://github.com/solidSpoon/DashPlayer/commit/84522b3ff33401f87da8d5d7c4510ea5453e40ef');
          assert(!fixture.requests.slice(requestStart).some(request => sameLanguageTexts.some(text => request.source.includes(text))), '同语言评论不得进入翻译请求');
        };
        for (let index = 0; index < sameLanguageTexts.length; index++) {
          await article.locator(`[data-same-language="${index}"]`).click();
          await article.keyboard.press('Control');
          await wait(150);
          await checkOriginals();
        }
        assert.equal(fixture.requests.length, requestStart, '同语言悬浮必须零请求');
        const controlCounts = [];
        for (const expected of [1, 0, 1]) {
          await article.keyboard.press('Alt+t');
          await article.waitForFunction(expected => ['english-control', 'traditional-control'].every(id =>
            document.querySelectorAll(`#${id} .fluent-read-bilingual-content`).length === expected), expected);
          await checkOriginals();
          controlCounts.push(await article.locator('#english-control .fluent-read-bilingual-content').count());
        }
        // 全文会话期间动态新增同语言评论，然后把它改为外语；必须重新检测，不能永久跳过节点。
        await article.evaluate(text => {
          const node = document.createElement('p'); node.id = 'dynamic-comment'; node.textContent = text;
          document.querySelector('main').append(node);
        }, sameLanguageTexts.at(-1));
        await wait(500);
        assert.equal(await article.locator('#dynamic-comment .fluent-read-bilingual-content').count(), 0);
        await checkOriginals();
        await article.evaluate(text => {document.querySelector('#dynamic-comment').textContent = text;}, paragraphs.en[0]);
        await article.locator('#dynamic-comment .fluent-read-bilingual-content').waitFor();
        await checkOriginals();
        await shot(article, 'same-language-comments');
        await article.keyboard.press('Alt+t');
        await article.waitForFunction(() => document.querySelectorAll('.fluent-read-bilingual-content').length === 0);
        assert.equal(await article.locator('#dynamic-comment').innerText(), paragraphs.en[0]);
        await checkOriginals();
        report.fixture.sameLanguage = {comments: sameLanguageTexts.length, hoverRequests: 0, sameLanguageWrappers: 0,
          foreignControlCounts: controlCounts, dynamicRedetection: true, restored: true};
      } finally {await article.close(); currentPage = popup;}
    }
    report.fixture.ok = true;
    if (report.liveGoogle.requested) {
      await patchConfig({service: 'google', useCache: false});
      for (const mode of ['hover', 'full']) {
        for (const pair of pairs) {
          try {report.liveGoogle.cases.push(await runCase(pair, mode, true));}
          catch (error) {
            report.liveGoogle.cases.push({...pair, mode, status: 'failed', error: error.stack || String(error)});
            // 防抢焦点/窗口校验失败必须立即结束，不能当作单个供应商故障继续创建页面。
            if (browserSafetyFailure) throw error;
          }
        }
      }
      report.liveGoogle.ok = report.liveGoogle.cases.every(item => item.status === 'passed');
      report.liveGoogle.evidenceBoundary = 'These requests use the actual Google provider without a fixture response; failures can include network or remote-service limitations and are reported separately from deterministic fixture results.';
    }
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    report.ok = report.fixture.ok && (!report.liveGoogle.requested || report.liveGoogle.ok);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    report.error = error.stack || String(error);
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
      report.visibleText = await currentPage.locator('body').innerText().catch(() => '');
    }
    process.exitCode = 1;
  } finally {
    report.fixture.requests = fixture.requests;
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close();
    await fixture.close();
    fs.rmSync(profileDir, {recursive: true, force: true});
    process.stdout.write(`${JSON.stringify({ok: report.ok, fixtureOk: report.fixture.ok,
      fixtureCases: report.fixture.cases.length, liveGoogle: report.liveGoogle, error: report.error, artifactsDir})}\n`);
  }
}
if (require.main === module) main().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
module.exports = {startFixture, fixtureTranslation, assertScript, paragraphs, pairs};
