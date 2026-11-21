'use strict';
const {waitForAsyncCondition} = require('./testing/wait-for-async-condition.cjs');
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');

// 网站适配生产包回归：隔离 Edge、真实快捷键、局部合成网页和本地翻译响应。
// 默认使用自建网页；--live 加载公开实站。两种模式均使用本地翻译响应。
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {inspectFixtureTranslationParts} = require('./site-translation/fixture-translation-parts.cjs');
const {controlledProviderRuntime} = require('./site-translation/controlled-provider.cjs');
const {assertFreshProductionExtension, waitForTranslationIdle, loadRuntimeDiagnostics,
  finishRuntimeDiagnostics, unloadRuntimePage} = require('./run-site-translation-test.cjs');
const argument = (key, fallback) => {
  const index = process.argv.indexOf(`--${key}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = path.resolve(__dirname, '..');
const extensionDir = path.resolve(argument('extension-dir', path.join(root, '.output/chrome-mv3')));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-site-adaptation-browser'));
const packages = argument('playwright-root', '');
const helperPath = argument('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'));
if (!packages || !helperPath) throw new Error('需要 --playwright-root 和 --focus-safe-helper');
const {chromium} = require(path.join(packages, 'playwright'));
const helper = require(path.resolve(helperPath));
const diagnosticsPath = argument('runtime-diagnostics-helper', '');
const runtimeDiagnostics = diagnosticsPath ? loadRuntimeDiagnostics(diagnosticsPath).diagnostics : null;
const timeout = 15000;
const wrapper = '.fluent-read-bilingual-content';
let profileDir;
fs.mkdirSync(artifactsDir, {recursive: true});
const isLive = process.argv.includes('--live');
const testSettingsUi = !isLive && !process.argv.includes('--skip-settings-ui');
const cases = JSON.parse(fs.readFileSync(path.join(root, isLive ? 'scripts/site-translation/site-adaptation-live-cases.json' : 'scripts/site-translation/site-adaptation-fixtures.json'), 'utf8'));
if (!isLive) cases.unshift(...JSON.parse(fs.readFileSync(path.join(root, 'scripts/site-translation/site-adaptation-established-fixtures.json'), 'utf8')));
const selectedIds = argument('cases', '').split(',').filter(Boolean);
if (selectedIds.length) cases.splice(0, cases.length, ...cases.filter(item => selectedIds.includes(item.id)));
cases.splice(0, cases.length, ...cases.flatMap(parent => [parent, ...(parent.variants ?? []).map(variant => ({
  ...parent, ...variant, id: parent.id, variant: variant.name,
}))].map(item => {
  const normalized = {...item};
  delete normalized.variants;
  return normalized;
})));
const customPack = {version: 1, rules: [{
  id: 'reader-local-test', name: '阅读范围测试', match: {hosts: ['reader.example.test'], paths: ['/articles/*']},
  mode: 'focus', content: [{css: ['article p[data-readable="yes"]'], resolve: 'closest'}], protect: ['.private'],
}]};
const customCase = {id: 'custom-rule', url: 'https://reader.example.test/articles/start',
  html: '<article><p id="first" data-readable="yes">This first article paragraph has readable source text.</p><p id="second" data-readable="yes">The second article paragraph remains independently selectable.</p><p id="private" class="private">Private metadata must remain original.</p></article><section><p id="outside">This unrelated panel is outside the reading scope.</p></section>',
  required: ['#first', '#second'], forbidden: ['#private', '#outside']};
if (!isLive && (!selectedIds.length || selectedIds.includes('custom-rule'))) cases.push(customCase);
assert.ok(cases.length, 'No matching site-adaptation cases');
for (const id of selectedIds) assert.ok(cases.some(item => item.id === id), `Unknown site-adaptation case: ${id}`);
const pageHtml = item => '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:18px/1.65 system-ui;margin:40px;max-width:900px}p,li,h1,h2{margin:16px 0}button{font:inherit}pre{white-space:pre-wrap}nav,aside{border:1px solid #ddd;padding:10px}</style></head><body>' + item.html + '</body></html>';
const report = {scope: isLive ? 'production-extension-live-pages-local-provider' : 'production-extension-domain-fixtures', provider: 'microsoft-local-response',
  limitations: ['Authored fixtures prove the declared structures, not live website acceptance', 'Local provider responses do not measure live service quality or latency', 'Full-only fixtures do not claim physical hover acceptance'],
  fixtureCases: [], ui: {}, consoleErrors: [], externalRequests: []};
let session;
let sequence = 0;
let popup;
let options;
let worker;
let context;
let testPage;
let runtimeStarted = false;
function setStage(item, stage) {
  item.stage = stage;
  runtimeDiagnostics?.setPhase(`${item.id}/${stage}`);
}
async function configRead() {
  return popup.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!result.success) throw new Error(result.error);
    return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  });
}
async function configPatch(updates) {
  const response = await popup.evaluate(async ({updates, sequence}) => {
    const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    const config = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    const expected = Object.fromEntries(Object.keys(updates).map(key => [key, config[key]]));
    return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates, expected,
      clientId: 'site-adaptation-browser', sequence, baseRevision: config.__fluentConfigRevision});
  }, {updates, sequence: ++sequence});
  assert.equal(response.success, true, JSON.stringify(response));
}
// persistConfig acknowledges background storage before the content document consumes it.
// A changed rule synchronously invalidates the old session, emits the existing ended
// event and publishes its adapters in the same stack. Poll after that event, rather
// than starting a hotkey session that a delayed configuration update can then clear.
async function configPatchAfterRuleInvalidation(page, updates) {
  await page.evaluate(() => {
    if (window.__adaptationRuleInvalidation) throw new Error('Rule invalidation wait already installed');
    const state = {count: 0};
    state.listener = () => { state.count += 1; };
    window.__adaptationRuleInvalidation = state;
    document.addEventListener('fluentread-translation-ended', state.listener);
  });
  try {
    await configPatch(updates);
    await page.waitForFunction(() => window.__adaptationRuleInvalidation?.count > 0, null, {timeout});
  } finally {
    await page.evaluate(() => {
      const state = window.__adaptationRuleInvalidation;
      if (state) document.removeEventListener('fluentread-translation-ended', state.listener);
      delete window.__adaptationRuleInvalidation;
    });
  }
}
function inspectFixtureOwnerInPage({selector, count, text, wrapper}) {
  const owners = document.querySelectorAll(selector);
  if (owners.length !== 1) return count === undefined && text === undefined ? null : false;
  const owner = owners[0];
  // A non-atomic container can own a direct opening and independent paragraph children.
  // Only its direct wrapper or its direct synthetic run belongs to this owner.
  const owned = [...owner.querySelectorAll(wrapper)].filter(node => node.parentElement === owner ||
    (node.parentElement?.matches('[data-fr-translation-segment="true"]') && node.parentElement.parentElement === owner));
  if (count !== undefined) return owned.length === count;
  const translatedText = owned.map(node => node.textContent).join('\n');
  if (text !== undefined) return (globalThis.__frAdaptationFixtureDecode(translatedText, () => true) ?? '').includes(text);
  return {count: owned.length, text: translatedText};
}
async function waitCount(page, selector, count) {
  await page.waitForFunction(inspectFixtureOwnerInPage, {selector, count, wrapper}, {timeout});
}
async function verifyOwnerText(page, selectors, label) {
  for (const selector of selectors) {
    const state = await page.evaluate(inspectFixtureOwnerInPage, {selector, wrapper});
    assert.match(state?.text ?? '', /[\u3400-\u9fff]/u, `${label}: ${selector} missing translated text`);
  }
}
async function fullToggle(page) {
  await helper.activateExtensionTabWithoutForeground(context, page);
  await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
}
function findAdaptationHoverPointInPage({selector, point, forbidden = []}) {
  const target = document.querySelector(selector);
  if (!target?.isConnected) return null;
  const pointerBarriers = '[data-fr-translation-owned="true"],.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper,' +
    '[hidden],[inert],nav,form,button,input,textarea,select,dialog,[role="dialog"],[role="alertdialog"],[contenteditable]:not([contenteditable="false"]),' +
    'pre,code,.notranslate,[data-notranslate="true"],.forum_topic_label';
  const excluded = `${pointerBarriers},[aria-hidden="true"]`;
  const declaredGuards = forbidden.length ? forbidden.join(',') : null;
  const guarded = node => node.closest(excluded) || (declaredGuards && node.closest(declaredGuards));
  const readableHit = (parent, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    const hit = stack[0];
    if (!hit || hit.closest(pointerBarriers) || guarded(parent)) return null;
    if (target.contains(hit) && (hit === parent || hit.contains(parent))) {
      if (hit.closest('[aria-hidden="true"]') || (declaredGuards && hit.closest(declaredGuards))) return null;
      return {policy: 'direct-text', stack};
    }
    // Steam's independently authored fixture keeps the observed empty stretched link.
    // Accept only its same-card transparent hit plus the actual source Range below it.
    if (hit.childNodes.length) return null;
    const steamCard = target.closest('.forum_topic[role="button"]');
    const steam = location.hostname === 'steamcommunity.com' && /^\/app\/[^/]+\/discussions\/$/u.test(location.pathname) &&
      target.matches('.forum_topic_name') && hit.matches('a.forum_topic_overlay') && steamCard && hit.parentElement === steamCard && hit.getAttribute('href');
    // The observed Google News home pair has the same href and at most one empty
    // stretched div around its hidden overlay; the readable title is a card child.
    // Only the overlay's self aria-hidden marker is permitted, never hidden source.
    const googleCard = target.parentElement;
    const googleOverlayWrapper = hit.parentElement !== googleCard && hit.parentElement?.tagName === 'DIV' &&
      hit.parentElement.parentElement === googleCard && hit.parentElement.childNodes.length === 1 && hit.parentElement.firstChild === hit
      ? hit.parentElement : null;
    const googleNews = location.hostname === 'news.google.com' && location.pathname === '/home' &&
      target.matches('main a[href^="./read/"]:not([aria-hidden="true"])') && hit.matches('a[aria-hidden="true"][href^="./read/"]') &&
      (hit.parentElement === googleCard || googleOverlayWrapper) && hit.getAttribute('href') === target.getAttribute('href') &&
      getComputedStyle(googleCard).position === 'relative';
    if (!steam && !googleNews) return null;
    const sourceIndex = googleNews && googleOverlayWrapper && stack[1] === googleOverlayWrapper ? 2 : 1;
    if (!target.contains(stack[sourceIndex]) || !(stack[sourceIndex] === parent || stack[sourceIndex]?.contains(parent))) return null;
    const ariaGuard = hit.closest('[aria-hidden="true"]');
    if (ariaGuard && (!googleNews || ariaGuard !== hit || hit.parentElement.closest('[aria-hidden="true"]'))) return null;
    // The audited empty overlay is itself an exact-HTML guard. Only that self
    // match may pass; a declared outer guard remains a real pointer barrier.
    if (declaredGuards && ((hit.closest(declaredGuards) && hit.closest(declaredGuards) !== hit) ||
      hit.parentElement.closest(declaredGuards))) return null;
    for (const layer of googleNews && googleOverlayWrapper ? [hit, googleOverlayWrapper] : [hit]) {
      const style = getComputedStyle(layer);
      const transparent = style.backgroundColor === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/u.test(style.backgroundColor);
      if (style.position !== 'absolute' || !['left', 'right', 'top', 'bottom'].every(key => style[key] === '0px') ||
        !transparent || style.backgroundImage !== 'none' || style.boxShadow !== 'none' || style.filter !== 'none' ||
        (style.backdropFilter && style.backdropFilter !== 'none') ||
        !['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'].every(key => style[key] === '0px')) return null;
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(layer, pseudo).content;
        if (content !== 'none' && content !== 'normal' && content !== '') return null;
      }
    }
    return {policy: googleNews ? 'google-news-empty-read-overlay' : 'steam-empty-stretched-link', stack};
  };
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || guarded(parent) || !node.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const x = point?.x ?? rect.x + Math.min(12, rect.width / 2), y = point?.y ?? rect.y + rect.height / 2;
      if (!rect.width || !rect.height || x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom ||
        x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
      const hit = readableHit(parent, x, y);
      if (hit) return {x, y, sourceText: node.textContent.trim().slice(0, 180), policy: hit.policy, stack: hit.stack.slice(0, 6).map(element => ({
        tag: element.tagName, id: element.id, className: typeof element.className === 'string' ? element.className : '',
      }))};
    }
  }
  return null;
}
async function hoverToggle(page, selector, positioningAttempt = 0, forbidden = []) {
  await helper.activateExtensionTabWithoutForeground(context, page);
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  // 实站可能带平滑滚动或吸顶导航；等待布局停止后再定位正文文字。
  await target.evaluate(async element => {
    let previous = element.getBoundingClientRect(), stable = 0;
    for (let index = 0; index < 40 && stable < 5; index++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const next = element.getBoundingClientRect();
      stable = Math.abs(next.x - previous.x) + Math.abs(next.y - previous.y) < 0.5 ? stable + 1 : 0;
      previous = next;
    }
  });
  const box = await target.boundingBox();
  assert.ok(box && box.width && box.height, selector);
  const point = await page.evaluate(findAdaptationHoverPointInPage, {selector, forbidden});
  if (!point) (report.pointerChecks ??= []).push({url: page.url(), selector, noReadablePoint: true,
    diagnostics: await target.evaluate(element => {
      const textRects = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode()) && textRects.length < 8) {
        const range = document.createRange(); range.selectNodeContents(node);
        textRects.push({text: node.textContent.slice(0, 160), parent: node.parentElement?.outerHTML.slice(0, 250),
          rects: [...range.getClientRects()].slice(0, 2).map(rect => ({x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            stack: document.elementsFromPoint(rect.x + Math.min(12, rect.width / 2), rect.y + rect.height / 2).slice(0, 5).map(hit => hit.outerHTML.slice(0, 200))}))});
      }
      return {textRects, target: element.outerHTML.slice(0, 1800)};
    })});
  assert.ok(point, `No visible readable text at ${selector}`);
  await page.mouse.move(0, 0);
  await page.mouse.move(point.x, point.y, {steps: 4});
  await page.waitForTimeout(100);
  const fresh = await page.evaluate(findAdaptationHoverPointInPage, {selector, point, forbidden});
  const mouse = await page.evaluate(() => globalThis.__lastReadingMouse);
  (report.pointerChecks ??= []).push({url: page.url(), selector, point, fresh, mouse});
  if (!fresh) {
    assert.ok(positioningAttempt < 5, 'Page kept moving away from the reading pointer');
    return hoverToggle(page, selector, positioningAttempt + 1, forbidden);
  }
  assert.equal(mouse?.trusted, true, `${selector}: browser pointer event was not trusted`);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
}
function inspectSteamTopicGeometryInPage({selectors, wrapper}) {
  const rectValue = rect => ({top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height});
  return selectors.flatMap(selector => {
    const title = document.querySelector(selector);
    if (!title?.matches('.forum_topic_name')) return [];
    const card = title.closest('.forum_topic'), author = card?.querySelector('.forum_topic_op');
    if (!card || !author) throw new Error(`Steam geometry requires title/card/author at ${selector}`);
    const translated = title.querySelector(wrapper);
    const rangeRects = (element, translatedOnly) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), rects = []; let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim() || (!translatedOnly && node.parentElement.closest('.fluent-read-bilingual-content,.forum_topic_label'))) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rectValue));
      }
      return rects;
    };
    const sourceRects = rangeRects(title, false);
    const translationRects = translated ? rangeRects(translated, true) : [];
    const clips = [];
    for (let ancestor = translated?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipX = /(hidden|clip|auto|scroll)/u.test(style.overflowX), clipY = /(hidden|clip|auto|scroll)/u.test(style.overflowY);
      if (clipX || clipY) clips.push({...rectValue(ancestor.getBoundingClientRect()), clipX, clipY});
      if (ancestor === card) break;
    }
    const translatedHeight = translationRects.length ? Math.max(...translationRects.map(rect => rect.bottom)) - Math.min(...translationRects.map(rect => rect.top)) : 0;
    const yClips = clips.filter(rect => rect.clipY);
    const visibleHeight = translationRects.length ? Math.max(0, Math.min(Math.max(...translationRects.map(rect => rect.bottom)), ...yClips.map(rect => rect.bottom)) -
      Math.max(Math.min(...translationRects.map(rect => rect.top)), ...yClips.map(rect => rect.top))) : 0;
    const clippedTranslationRects = translationRects.map(rect => ({
      width: Math.max(0, Math.min(rect.right, ...clips.filter(clip => clip.clipX).map(clip => clip.right)) - Math.max(rect.left, ...clips.filter(clip => clip.clipX).map(clip => clip.left))),
      height: Math.max(0, Math.min(rect.bottom, ...yClips.map(clip => clip.bottom)) - Math.max(rect.top, ...yClips.map(clip => clip.top))),
    }));
    const cardRect = card.getBoundingClientRect(), authorRect = author.getBoundingClientRect();
    const next = card.nextElementSibling?.matches('.forum_topic') ? card.nextElementSibling.getBoundingClientRect() : null;
    return [{selector, sourceRects, translationRects, clippedTranslationRects, clips, translatedHeight, visibleHeight,
      title: rectValue(title.getBoundingClientRect()), card: rectValue(cardRect), author: rectValue(authorRect),
      authorCardOverflow: Math.max(0, authorRect.bottom - cardRect.bottom),
      nextCardClearance: next ? next.top - authorRect.bottom : null,
      translationAuthorClearance: translationRects.length ? authorRect.top - Math.max(...translationRects.map(rect => rect.bottom)) : null}];
  });
}
async function verifySteamTopicGeometry(page, item, evidence, baseline, phase, selectors = item.required) {
  if (!baseline.length) return;
  const measured = await page.evaluate(inspectSteamTopicGeometryInPage, {selectors, wrapper});
  (evidence.steamGeometry ??= []).push({phase, measured});
  for (const current of measured) {
    const old = baseline.find(value => value.selector === current.selector);
    assert.ok(current.translatedHeight > 0 && current.visibleHeight >= current.translatedHeight - 0.5,
      `${item.id}/${current.selector}: translated title is vertically clipped (${current.visibleHeight}/${current.translatedHeight})`);
    assert.ok(current.clippedTranslationRects.every((rect, index) => rect.width >= current.translationRects[index].width - 0.5 && rect.height >= current.translationRects[index].height - 0.5),
      `${item.id}/${current.selector}: translated title text Range exceeds its visible clipping area`);
    assert.ok(current.translationAuthorClearance >= -0.5, `${item.id}/${current.selector}: translated title overlaps original author`);
    if (old) {
      assert.ok(current.authorCardOverflow <= old.authorCardOverflow + 0.5, `${item.id}/${current.selector}: author overflows card farther after translation`);
      if (old.nextCardClearance !== null && current.nextCardClearance !== null) assert.ok(current.nextCardClearance >= Math.min(0, old.nextCardClearance) - 0.5,
        `${item.id}/${current.selector}: original author overlaps the neighboring card farther after translation`);
    }
  }
}
async function verifyProtected(page, item, original) {
  for (let index = 0; index < item.forbidden.length; index++) {
    const node = page.locator(item.forbidden[index]);
    assert.equal(await node.locator(wrapper).count(), 0, `${item.id} protected wrapper`);
    assert.equal(await node.textContent(), original[index].text, `${item.id} protected text`);
    assert.equal(await node.evaluate(element => element.outerHTML), original[index].html, `${item.id} protected HTML`);
  }
  assert.equal(page.url(), item.expectedUrl ?? item.url);
  assert.equal(await page.locator(`${wrapper} ${wrapper}`).count(), 0, 'nested wrappers');
}

async function guardSnapshot(page, selectors, expected = false) {
  return page.evaluate(({selectors, expected}) => {
    const root = expected ? window.__adaptationFixtureHost : document;
    return selectors.map(selector => {
      const nodes = root.querySelectorAll(selector);
      if (nodes.length !== 1) throw new Error(`Guard must match exactly one element: ${selector} (${nodes.length})`);
      return {text: nodes[0].textContent, html: nodes[0].outerHTML};
    });
  }, {selectors, expected});
}
async function verifyLatestFixtureRestore(page, item, forbidden) {
  for (const selector of item.restoreSelectors) {
    const state = await page.evaluate(selector => {
      const actual = document.querySelectorAll(selector), expected = __adaptationFixtureHost.querySelectorAll(selector);
      if (actual.length !== 1 || expected.length !== 1) throw new Error(`Restore target must be unique: ${selector}`);
      return {actual: actual[0].innerHTML, expected: expected[0].innerHTML};
    }, selector);
    assert.equal(state.actual, state.expected, `${item.id}: latest host HTML not restored at ${selector}`);
  }
  await verifyProtected(page, {...item, forbidden}, await guardSnapshot(page, forbidden, true));
}

// Optional authored-fixture operations. The detached expected host is captured before
// translation, receives only these declared host writes, and is never a product runtime hook.
// dynamic: {appendHtml:[{selector,html,required,forbidden,sourceIncludes,sourceExcludes,click,route,scroll}],
//   inlineText:[{selector,owner,from,to}], noiseSelector,noiseText,remountSelector,
//   override:{protect,required,lateText?:{selector,owner,from,to}}}
async function fixtureHostWrite(page, operation) {
  const nextUrl = operation.route ? new URL(operation.route, page.url()).href : null;
  await page.evaluate(operation => {
    const one = (root, selector) => {
      const nodes = [...root.querySelectorAll(selector)].filter(node =>
        !node.closest('.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper'));
      if (nodes.length !== 1) throw new Error(`Host write target must be unique: ${selector}`);
      return nodes[0];
    };
    const expected = window.__adaptationFixtureHost;
    if (!expected) throw new Error('Missing original fixture host snapshot');
    const actual = one(document, operation.selector);
    const template = one(expected, operation.selector);
    if (actual === document.body || actual === document.documentElement || actual.closest('.fluent-read-bilingual-content')) {
      throw new Error('Host write cannot target a document surface or owned translation');
    }
    if (operation.kind === 'append') {
      const append = () => {
        if (operation.route) {
          const url = new URL(operation.route, location.href);
          if (url.origin !== location.origin) throw new Error('Fixture navigation must stay on the same origin');
          history.pushState({}, '', url.href);
        }
        actual.insertAdjacentHTML('beforeend', operation.html);
        template.insertAdjacentHTML('beforeend', operation.html);
      };
      if (operation.click) {
        const control = one(document, operation.click);
        const nativeLabel = window.__adaptationFixtureControls.get(operation.click);
        control.addEventListener('click', () => {
          // Mimic a renderer committing removal against the original Text node.
          // Removing it throws if translation reparented the host's label.
          control.removeChild(nativeLabel);
          control.append(nativeLabel);
          append();
        }, {once: true});
      } else append();
    } else if (operation.kind === 'text') {
      const replace = root => {
        const matches = [];
        const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) if (node.data === operation.from &&
          !node.parentElement?.closest('.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper')) matches.push(node);
        if (matches.length !== 1) throw new Error(`Expected one original Text slot at ${operation.selector}, found ${matches.length}`);
        matches[0].data = operation.to;
      };
      const templateBefore = template.innerHTML;
      replace(template);
      try { replace(actual); } catch (error) { template.innerHTML = templateBefore; throw error; }
    } else if (operation.kind === 'noise') {
      if (actual.querySelector('.fluent-read-bilingual-content') || !operation.guards.some(selector =>
        actual.matches(selector) || actual.closest(selector))) throw new Error('Noise must stay inside a declared protected guard');
      actual.textContent = operation.text; template.textContent = operation.text;
    } else if (operation.kind === 'remount') {
      actual.replaceWith(template.cloneNode(true));
    } else throw new Error(`Unknown fixture host write: ${operation.kind}`);
  }, operation);
  if (operation.click) await page.locator(operation.click).click();
  if (nextUrl) await page.waitForURL(nextUrl, {timeout});
  return nextUrl;
}

async function runFixtureDynamic(page, item, evidence) {
  const dynamic = item.dynamic;
  assert.ok(!isLive && dynamic && typeof dynamic === 'object', 'Dynamic operations require an authored fixture');
  assert.ok(item.restoreSelectors?.length, `${item.id}: dynamic fixture requires restoreSelectors`);
  const required = [...item.required];
  const forbidden = [...item.forbidden];
  const includes = [];
  const excludes = [];
  const requestStart = await worker.evaluate(() => __adaptationRequests.length);
  const verify = async () => {
    for (const selector of required) await waitCount(page, selector, 1);
    await waitForTranslationIdle(page, timeout, `${item.id}-${item.stage}`, timeout);
    await verifyOwnerText(page, required, item.id);
    await verifyProtected(page, {...item, forbidden}, await guardSnapshot(page, forbidden, true));
  };
  const exactRestore = () => verifyLatestFixtureRestore(page, item, forbidden);
  evidence.dynamic = {steps: [], restoreSelectors: item.restoreSelectors, restoreScope: 'declared-container-innerHTML'};
  for (const operation of dynamic.appendHtml ?? []) {
    setStage(item, operation.click ? 'dynamic-expand' : operation.route ? 'dynamic-route' : 'dynamic-append');
    assert.ok(typeof operation.html === 'string' && operation.required?.length, 'appendHtml requires html and required targets');
    const navigatedUrl = await fixtureHostWrite(page, {...operation, kind: 'append'});
    if (navigatedUrl) item.expectedUrl = navigatedUrl;
    if (operation.scroll) await page.locator(operation.scroll).scrollIntoViewIfNeeded();
    required.push(...operation.required.filter(selector => !required.includes(selector)));
    forbidden.push(...(operation.forbidden ?? []).filter(selector => !forbidden.includes(selector)));
    includes.push(...(operation.sourceIncludes ?? [])); excludes.push(...(operation.sourceExcludes ?? []));
    await verify(); evidence.dynamic.steps.push({kind: 'append', selector: operation.selector, required: operation.required,
      ...(operation.click ? {clicked: operation.click} : {}),
      ...(operation.scroll ? {scrolledTo: operation.scroll} : {}),
      ...(operation.route ? {navigatedTo: page.url()} : {})});
  }
  for (const operation of dynamic.inlineText ?? []) {
    setStage(item, 'dynamic-inline-text');
    assert.ok(typeof operation.from === 'string' && typeof operation.to === 'string' && operation.from !== operation.to && operation.owner,
      'inlineText requires a changed original Text slot and its translation owner');
    await fixtureHostWrite(page, {...operation, kind: 'text'});
    await page.waitForFunction(inspectFixtureOwnerInPage, {selector: operation.owner, text: operation.to, wrapper}, {timeout});
    includes.push(operation.to);
    await verify(); evidence.dynamic.steps.push({kind: 'inlineText', selector: operation.selector, owner: operation.owner, text: operation.to});
  }
  if (dynamic.noiseSelector) {
    setStage(item, 'dynamic-protected-noise');
    assert.ok(typeof dynamic.noiseText === 'string' && dynamic.noiseText.trim(), 'noiseSelector requires a unique nonempty noiseText');
    await verify();
    const beforeRequests = await worker.evaluate(() => __adaptationRequests.length);
    await page.evaluate(() => { window.__adaptationNoiseWrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')]
      .map(node => ({node, html: node.outerHTML})); });
    for (let index = 0; index < 4; index++) {
      await fixtureHostWrite(page, {kind: 'noise', selector: dynamic.noiseSelector, text: `${dynamic.noiseText} ${index}`, guards: forbidden});
      await page.waitForTimeout(50);
    }
    await verify();
    assert.equal(await worker.evaluate(() => __adaptationRequests.length), beforeRequests, `${item.id}: protected noise caused provider work`);
    assert.equal(await page.evaluate(() => {
      const current = [...document.querySelectorAll('.fluent-read-bilingual-content')];
      const old = __adaptationNoiseWrappers;
      delete window.__adaptationNoiseWrappers;
      return current.length === old.length && current.every((node, index) => node === old[index].node && node.outerHTML === old[index].html);
    }), true, `${item.id}: protected noise rebuilt or changed translated DOM`);
    excludes.push(dynamic.noiseText);
    evidence.dynamic.steps.push({kind: 'protectedNoise', selector: dynamic.noiseSelector, writes: 4, providerWork: 0, sameWrappers: true});
  }
  if (dynamic.remountSelector) {
    setStage(item, 'dynamic-equivalent-remount');
    await fixtureHostWrite(page, {kind: 'remount', selector: dynamic.remountSelector});
    await verify(); evidence.dynamic.steps.push({kind: 'equivalentRemount', selector: dynamic.remountSelector});
  }
  const payload = (await worker.evaluate(start => __adaptationRequests.slice(start).flat().join('\n'), requestStart)).replace(/\s+/gu, ' ');
  for (const text of includes) assert.ok(payload.includes(text.replace(/\s+/gu, ' ')), `${item.id}: dynamic source missing ${text}`);
  for (const text of excludes) assert.ok(!payload.includes(text.replace(/\s+/gu, ' ')), `${item.id}: dynamic protected source reached provider ${text}`);
  for (const guard of await guardSnapshot(page, forbidden, true)) if (guard.text.trim()) {
    assert.ok(!payload.includes(guard.text.trim()), `${item.id}: dynamic protected guard reached provider`);
  }
  setStage(item, 'dynamic-restore'); await fullToggle(page);
  await page.waitForFunction(wrapper => !document.querySelector(wrapper), wrapper, {timeout});
  await exactRestore(); evidence.dynamic.restoreExact = true;
  setStage(item, 'dynamic-retranslate'); await fullToggle(page); await verify();
  evidence.dynamic.retranslated = true;
  if (dynamic.override) {
    const settings = (await configRead()).siteAdaptation;
    const builtin = ['websites', 'established'].flatMap(name => JSON.parse(fs.readFileSync(path.join(root, 'src/core/site-adaptation/catalog', `${name}.json`), 'utf8')))
      .find(rule => rule.id === item.id);
    assert.ok(builtin && dynamic.override.protect?.length && dynamic.override.required?.length, 'override requires a matching built-in id, protect and required targets');
    const updated = structuredClone(settings);
    updated.custom.rules = updated.custom.rules.filter(rule => rule.id !== item.id);
    const replacement = {...builtin, protect: [...new Set([...(builtin.protect ?? []), ...dynamic.override.protect])]};
    if (builtin.profile) {
      updated.custom.profiles ??= {};
      updated.custom.profiles[builtin.profile] = JSON.parse(fs.readFileSync(path.join(root, 'src/core/site-adaptation/catalog/profiles.json'), 'utf8'))[builtin.profile];
    }
    updated.custom.rules.push(replacement);
    try {
      if (dynamic.override.lateText) {
        setStage(item, 'dynamic-held-source');
        await worker.evaluate(() => { __adaptationHold = true; });
        await fixtureHostWrite(page, {...dynamic.override.lateText, kind: 'text'});
        await waitForAsyncCondition(() => worker.evaluate(() => __adaptationReleases.length > 0),
          {timeoutMs: timeout, message: `${item.id}: held provider response`});
      }
      setStage(item, 'dynamic-same-id-override');
      await configPatchAfterRuleInvalidation(page, {siteAdaptation: updated});
      await page.waitForFunction(wrapper => !document.querySelector(wrapper), wrapper, {timeout});
      await worker.evaluate(() => { __adaptationHold = false; __adaptationReleases.splice(0).forEach(release => release()); });
      await waitForTranslationIdle(page, timeout, `${item.id}-released-stale-response`, timeout);
      assert.equal(await page.locator(wrapper).count(), 0, `${item.id}: old response resurrected after same-id override`);
      await exactRestore();
      await fullToggle(page);
      for (const selector of dynamic.override.required) await waitCount(page, selector, 1);
      await waitForTranslationIdle(page, timeout, `${item.id}-override`, timeout);
      await verifyOwnerText(page, dynamic.override.required, `${item.id}-override`);
      for (const selector of dynamic.override.protect) {
        await waitCount(page, selector, 0);
        await verifyProtected(page, {...item, forbidden: [selector]}, await guardSnapshot(page, [selector], true));
      }
      await fullToggle(page);
      await page.waitForFunction(wrapper => !document.querySelector(wrapper), wrapper, {timeout});
      await exactRestore();
      evidence.dynamic.override = {sameId: item.id, protected: dynamic.override.protect, remaining: dynamic.override.required,
        staleResponseDidNotCommit: Boolean(dynamic.override.lateText), restoreExact: true,
        restoreScope: 'declared-container-innerHTML', stableIdleMsAfterRelease: 1200,
        contentRuleApplySignal: 'fluentread-translation-ended', waitedBeforeRestart: true};
    } finally {
      await worker.evaluate(() => { __adaptationHold = false; __adaptationReleases.splice(0).forEach(release => release()); });
      await configPatchAfterRuleInvalidation(page, {siteAdaptation: settings});
    }
    await fullToggle(page); await verify();
  }
}
async function runCase(page, item) {
  setStage(item, 'navigation');
  await page.goto(item.url, {waitUntil: 'domcontentloaded'});
  await page.locator('#fluent-read-page-styles').waitFor({state: 'attached', timeout});
  await page.waitForTimeout(200);
  await page.evaluate(() => document.addEventListener('mousemove', event => {
    globalThis.__lastReadingMouse = {x: event.clientX, y: event.clientY, trusted: event.isTrusted,
      target: event.target?.outerHTML?.slice(0, 250)};
  }, {capture: true}));
  if (isLive) {
    // Docusaurus 的客户端接管可能替换服务端节点；完成后再添加断言标记。
    const generator = await page.evaluate(() => document.querySelector('meta[name="generator"]')?.getAttribute('content'));
    if (generator?.startsWith('Docusaurus')) {
      await page.locator('html[data-has-hydrated="true"]').waitFor({state: 'attached', timeout});
    }
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
      .some(node => node.textContent.trim().length >= 70 && node.getBoundingClientRect().height > 0), item.selector, {timeout});
    const count = await page.locator(item.selector).evaluateAll(nodes => {
      const candidates = nodes.filter(node => node.textContent.trim().length >= 70 && node.getBoundingClientRect().height > 0 && !node.closest('nav,pre,code,button,li,[contenteditable]'));
      candidates.slice(0, 2).forEach((node, index) => node.setAttribute('data-reading-check', String(index)));
      return candidates.length;
    });
    assert.ok(count >= 1, 'live readable paragraphs unavailable');
    item.required = Array.from({length: Math.min(count, 2)}, (_, index) => `[data-reading-check="${index}"]`);
    const guardCount = await page.locator('pre, nav').evaluateAll(nodes => {
      const candidates = nodes.filter(node => node.textContent.trim() && node.getBoundingClientRect().height > 0).slice(0, 2);
      candidates.forEach((node, index) => node.setAttribute('data-reading-guard', String(index)));
      return candidates.length;
    });
    item.forbidden = Array.from({length: guardCount}, (_, index) => `[data-reading-guard="${index}"]`);
    for (const selector of item.guardSelectors ?? []) {
      if (await page.locator(selector).count() === 1) item.forbidden.push(selector);
    }
    item.requestedUrl = item.url; item.url = page.url();
  }
  if (!isLive && item.dynamic) await page.evaluate(controls => {
    window.__adaptationFixtureHost = new DOMParser().parseFromString(document.documentElement.outerHTML, 'text/html');
    window.__adaptationFixtureControls = new Map(controls.map(selector => {
      const control = document.querySelector(selector);
      const label = [...(control?.childNodes ?? [])].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!label) throw new Error(`Missing original fixture control label: ${selector}`);
      return [selector, label];
    }));
  }, (item.dynamic.appendHtml ?? []).map(operation => operation.click).filter(Boolean));
  const requestStart = await worker.evaluate(() => __adaptationRequests.length);
  const original = await guardSnapshot(page, item.forbidden);
  const steamBaseline = new URL(item.url).hostname === 'steamcommunity.com' && /^\/app\/[^/]+\/discussions\/$/u.test(new URL(item.url).pathname)
    ? await page.evaluate(inspectSteamTopicGeometryInPage, {selectors: item.required, wrapper}) : [];
  const source = await Promise.all(item.required.map(selector => page.locator(selector).textContent()));
  const restoredHTML = await Promise.all((item.restoreSelectors ?? []).map(selector => page.locator(selector).innerHTML()));
  const evidence = {id: item.id, ...(item.variant ? {variant: item.variant} : {}), url: item.url,
    kind: isLive ? 'live-page-local-provider' : 'synthetic-domain-fixture', hover: [], full: [],
    wrapperCountScope: 'direct-owner-or-direct-synthetic-run', protected: item.forbidden.length, protectedExactHtml: true};
  if (steamBaseline.length) evidence.steamGeometryBaseline = {scope: 'authored simplified card geometry', measured: steamBaseline};
  const hoverEnabled = !process.argv.includes('--full-only') && (!item.modes || item.modes.includes('hover'));
  if (!hoverEnabled) evidence.hoverSkipped = 'Explicit full-only scope; no physical hover acceptance claimed';
  for (const count of hoverEnabled ? [1, 0, 1, 0] : []) {
    setStage(item, `hover-${evidence.hover.length}-${count}`);
    await hoverToggle(page, item.required[0], 0, item.forbidden);
    await waitCount(page, item.required[0], count);
    await page.waitForTimeout(350);
    await verifyProtected(page, item, original);
    for (const selector of item.required.slice(1)) assert.equal((await page.evaluate(inspectFixtureOwnerInPage, {selector, wrapper})).count, 0, 'hover changed neighbor owner');
    if (count === 1) {
      await waitForTranslationIdle(page, timeout, `${item.id}-${item.stage}`, timeout); await verifyOwnerText(page, [item.required[0]], item.id);
      await verifySteamTopicGeometry(page, item, evidence, steamBaseline, item.stage, [item.required[0]]);
    }
    evidence.hover.push(count);
  }
  for (const count of [1, 0, 1]) {
    setStage(item, `full-${evidence.full.length}-${count}`);
    await fullToggle(page);
    for (const selector of item.required) await waitCount(page, selector, count);
    if (item.dynamic || item.sourceAssertions) {
      await waitForTranslationIdle(page, timeout, `${item.id}-${item.stage}`, timeout);
      if (count === 1) await verifyOwnerText(page, item.required, item.id);
    }
    if (item.translationParts) {
      if (count === 1) {
        await page.waitForFunction(inspectFixtureTranslationParts, {parts: item.translationParts, requireAll: true}, {timeout});
        (evidence.translationParts ??= []).push(await page.evaluate(inspectFixtureTranslationParts, {parts: item.translationParts}));
      } else {
        await page.waitForFunction(() => !document.querySelector(
          '.fluent-read-bilingual-content, [data-fr-translation-segment="true"]'), null, {timeout});
      }
    }
    await verifyProtected(page, item, original);
    if (count === 1) await verifySteamTopicGeometry(page, item, evidence, steamBaseline, item.stage);
    if (count === 0) for (let index = 0; index < item.required.length; index++) assert.equal(await page.locator(item.required[index]).textContent(), source[index]);
    if (count === 0) for (let index = 0; index < restoredHTML.length; index++) {
      assert.equal(await page.locator(item.restoreSelectors[index]).innerHTML(), restoredHTML[index], `${item.id}: mixed source structure not restored`);
    }
    evidence.full.push(count);
  }
  if (!isLive) {
    const payload = await worker.evaluate(start => globalThis.__adaptationRequests.slice(start).flat().join('\n'), requestStart);
    for (const guard of original) if (guard.text.trim()) assert.ok(!payload.includes(guard.text.trim()), `${item.id}: protected text reached provider`);
    const normalized = payload.replace(/\s+/gu, ' ');
    for (const text of item.sourceAssertions?.required ?? []) assert.ok(normalized.includes(text.replace(/\s+/gu, ' ')), `${item.id}: declared source missing ${text}`);
    for (const text of item.sourceAssertions?.forbidden ?? []) assert.ok(!normalized.includes(text.replace(/\s+/gu, ' ')), `${item.id}: forbidden source reached provider ${text}`);
    for (const part of item.translationParts ?? []) {
      assert.ok(payload.replace(/\s+/gu, ' ').includes(part.sourceIncludes), `${item.id}: source part did not reach provider`);
      for (const literal of [...(part.preservedText ?? []), ...(part.omittedText ?? [])]) {
        assert.ok(!payload.replace(/\s+/gu, ' ').includes(literal.replace(/\s+/gu, ' ')), `${item.id}: protected part reached provider`);
      }
    }
    evidence.providerProtection = true;
    if (item.sourceAssertions) evidence.sourceAssertions = item.sourceAssertions;
  }
  if (item.dynamic) await runFixtureDynamic(page, item, evidence);
  if (item.id === 'custom-rule') {
    await page.evaluate(() => {
      const p = document.createElement('p'); p.id = 'dynamic'; p.dataset.readable = 'yes'; p.textContent = 'A newly inserted paragraph must enter the active translation session.';
      document.querySelector('article').append(p);
    });
    await waitCount(page, '#dynamic', 1);
    evidence.dynamic = true;
    await page.locator('#second').evaluate(node => { node.dataset.readable = 'no'; });
    await waitCount(page, '#second', 0);
    await page.locator('#second').evaluate(node => { node.dataset.readable = 'yes'; });
    await waitCount(page, '#second', 1);
    evidence.attributeReclassification = true;
    const updated = structuredClone(customPack);
    updated.rules[0].protect.push('#second');
    await configPatch({siteAdaptation: {enabled: true, disabledRuleIds: [], custom: updated}});
    await page.waitForFunction(wrapper => document.querySelectorAll(wrapper).length === 0, wrapper, {timeout});
    await fullToggle(page);
    await waitCount(page, '#first', 1);
    assert.equal(await page.locator('#second').locator(wrapper).count(), 0);
    evidence.liveConfigInvalidation = true;
    await fullToggle(page);
    await worker.evaluate(() => { globalThis.__adaptationHold = true; });
    await page.locator('#first').evaluate(node => { node.textContent = 'This delayed source must never resurrect after a stricter rule is saved.'; });
    await fullToggle(page);
    await worker.evaluate(async () => {
      const deadline = Date.now() + 8000;
      while (!globalThis.__adaptationReleases.length) {
        if (Date.now() > deadline) throw new Error('Delayed provider request did not arrive');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    updated.rules[0].protect.push('#first');
    await configPatch({siteAdaptation: {enabled: true, disabledRuleIds: [], custom: updated}});
    await worker.evaluate(() => { globalThis.__adaptationHold = false; globalThis.__adaptationReleases.splice(0).forEach(release => release()); });
    await page.waitForTimeout(500);
    assert.equal(await page.locator(wrapper).count(), 0, 'late response resurrected cancelled translation');
    evidence.lateResponseCancelled = true;
    await page.evaluate(() => history.pushState({}, '', '/settings'));
    // 切换路由后 focus 规则不再命中，原本不在正文白名单内的面板恢复通用候选资格。
    await hoverToggle(page, '#outside');
    await waitCount(page, '#outside', 1);
    evidence.spaPathRematch = true;
  }
  const artifactName = item.variant ? `${item.id}-${item.variant}` : item.id;
  assert.match(artifactName, /^[a-zA-Z0-9_-]+$/u, 'Unsafe fixture artifact name');
  if (!isLive) {
    fs.writeFileSync(path.join(artifactsDir, `${artifactName}.html`), await page.content());
    fs.writeFileSync(path.join(artifactsDir, `${artifactName}-requests.json`), JSON.stringify(await worker.evaluate(start => __adaptationRequests.slice(start), requestStart), null, 2));
  }
  await page.screenshot({path: path.join(artifactsDir, `${artifactName}.png`), fullPage: false, caret: 'initial'});
  if (item.id !== 'custom-rule') await fullToggle(page);
  if (item.dynamic) {
    await page.waitForFunction(wrapper => !document.querySelector(wrapper), wrapper, {timeout});
    const dynamicForbidden = [...item.forbidden, ...(item.dynamic.appendHtml ?? []).flatMap(operation => operation.forbidden ?? [])];
    await verifyLatestFixtureRestore(page, item, dynamicForbidden);
    evidence.dynamic.finalRestoreExact = true;
    await page.evaluate(() => { delete window.__adaptationFixtureHost; delete window.__adaptationFixtureControls; });
  }
  report.fixtureCases.push(evidence);
  fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
}
async function openAdaptation() {
  await options.locator('[data-section="settings-sites"]').click();
  const card = options.locator('[data-setting="site-adaptation"]');
  if ((await card.getAttribute('open')) === null) await card.locator(':scope > summary').click();
  return card;
}
async function main() {
  let primaryError;
  let launchAttempted = false;
  try {
    report.buildFreshness = assertFreshProductionExtension(extensionDir, root);
    report.contentSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(extensionDir, 'content-scripts/content.js'))).digest('hex');
    report.profileMode = 'new-temporary-profile';
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-site-adaptation-'));
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false,
      viewport: {width: 1280, height: 900}, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir);
    context = session.context;
    report.browserVersion = await context.browser().version();
    if (!testSettingsUi) report.ui.skipped = isLive ? 'Live-page scope' : 'Explicit --skip-settings-ui scope';
    if (isLive) await context.setExtraHTTPHeaders({'Accept-Language': 'en-US,en;q=0.9'});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    if (runtimeDiagnostics) {
      runtimeDiagnostics.setPhase('extension-initialization');
      await runtimeDiagnostics.start(context);
      runtimeStarted = true;
    } else report.limitations.push('No isolated-world or service-worker runtime diagnostic collector');
    await context.addInitScript(`globalThis.__frAdaptationFixtureDecode = (${controlledProviderRuntime.toString()})(false).decodeText;`);
    const attach = async page => {
      page.on('pageerror', error => report.consoleErrors.push(error.message));
      await runtimeDiagnostics?.attachPage(page, 'site-adaptation-fixture');
    };
    const installWorker = async current => {
      await current.evaluate(controlledProviderRuntime, true);
      await current.evaluate(() => {
        const {encode} = globalThis.__frCompatibilityTransport;
        globalThis.__adaptationRequests = [];
        globalThis.__adaptationHold = false; globalThis.__adaptationReleases = [];
        globalThis.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
          if (url.hostname === 'edge.microsoft.com' && url.pathname === '/translate/translatetext') {
            const body = init?.body ?? await input.text();
            const texts = JSON.parse(body);
            globalThis.__adaptationRequests.push(texts);
            if (globalThis.__adaptationHold) await new Promise(resolve => globalThis.__adaptationReleases.push(resolve));
            return new Response(JSON.stringify(texts.map(text => ({translations: [{text: encode(text, 'microsoft-escaped-text')}]}))), {status: 200, headers: {'content-type': 'application/json'}});
          }
          throw new Error(`External worker fetch disabled: ${url.origin}`);
        };
      });
    };
    context.on('serviceworker', next => { void installWorker(next).catch(error => report.consoleErrors.push(error.message)); });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await installWorker(worker);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const item = cases.find(item => item.url === url.href);
      if (!isLive && item && route.request().isNavigationRequest()) return route.fulfill({status: 200, contentType: 'text/html', body: pageHtml(item)});
      if (isLive) return route.continue();
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (!url.pathname.endsWith('favicon.ico')) report.externalRequests.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const id = new URL(worker.url()).host;
    runtimeDiagnostics?.setExtensionId(id);
    popup = await helper.newPageWithoutForeground(context); await attach(popup);
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForTimeout(1000);
    await configPatch({service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false, hotkey: 'Control', mouseHoverTranslationDelay: 0,
      fullPageTranslationMode: 'all', useCache: false, enableAIContext: false, enableAIMultiSegment: false,
      uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true,
      siteAdaptation: {enabled: true, disabledRuleIds: [], custom: customPack}});
    if (testSettingsUi) {
    options = await helper.newPageWithoutForeground(context); await attach(options);
    await options.goto(`chrome-extension://${id}/options.html#settings-sites`);
    await options.waitForTimeout(600);
    let card = await openAdaptation();
    const textarea = card.locator('textarea');
    const persistedBefore = (await configRead()).siteAdaptation;
    await textarea.fill('{"version":9,"rules":[]}');
    await card.getByRole('button', {name: '保存规则', exact: true}).click();
    await card.getByRole('alert').waitFor();
    assert.deepEqual((await configRead()).siteAdaptation, persistedBefore);
    report.ui.invalidDraftPreserved = true;
    await textarea.fill(JSON.stringify(customPack, null, 2));
    const extra = structuredClone(customPack); extra.rules[0].name = '持久化阅读规则';
    await textarea.fill(JSON.stringify(extra, null, 2));
    await options.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.__restoreAdaptationSend = () => { chrome.runtime.sendMessage = original; };
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message?.type === 'persistConfig' && message.config?.siteAdaptation) {
          const response = {success: false, error: 'fixture: simulated configuration persistence failure'};
          const callback = args.at(-1);
          if (typeof callback === 'function') { queueMicrotask(() => callback(response)); return; }
          return Promise.resolve(response);
        }
        return original(message, ...args);
      };
    });
    await card.getByRole('button', {name: '保存规则', exact: true}).click();
    await card.getByRole('alert').filter({hasText: '保存失败'}).waitFor();
    assert.equal(JSON.parse(await textarea.inputValue()).rules[0].name, '持久化阅读规则');
    assert.deepEqual((await configRead()).siteAdaptation, persistedBefore);
    await options.evaluate(() => globalThis.__restoreAdaptationSend());
    report.ui.failedSaveKeepsDraft = true;
    await card.getByRole('button', {name: '保存规则', exact: true}).click();
    await options.waitForTimeout(800);
    assert.equal((await configRead()).siteAdaptation.custom.rules[0].name, '持久化阅读规则');
    await options.reload(); card = await openAdaptation();
    assert.equal(JSON.parse(await card.locator('textarea').inputValue()).rules[0].name, '持久化阅读规则');
    report.ui.reopenPersistence = true;
    await card.getByRole('textbox', {name: '输入完整网址', exact: true}).fill(customCase.url);
    await card.locator('.adaptation-preview').getByText('持久化阅读规则').waitFor();
    report.ui.urlPreview = true;
    const downloadPromise = options.waitForEvent('download');
    await card.getByRole('button', {name: '导出已保存规则', exact: true}).click();
    const download = await downloadPromise;
    const exportPath = path.join(artifactsDir, 'custom-rules-export.json');
    await download.saveAs(exportPath);
    assert.equal(JSON.parse(fs.readFileSync(exportPath, 'utf8')).rules[0].name, '持久化阅读规则');
    await card.getByRole('button', {name: '清空自定义草稿', exact: true}).click();
    assert.equal(JSON.parse(await card.locator('textarea').inputValue()).rules.length, 0);
    await card.getByRole('button', {name: '撤销草稿替换', exact: true}).click();
    assert.equal(JSON.parse(await card.locator('textarea').inputValue()).rules[0].name, '持久化阅读规则');
    await card.locator('input[type="file"]').setInputFiles(exportPath);
    await card.getByRole('status').filter({hasText: '已导入草稿'}).waitFor();
    assert.equal(JSON.parse(await card.locator('textarea').inputValue()).rules[0].name, '持久化阅读规则');
    report.ui.importExportUndo = true;
    await card.getByText('查看内置规则', {exact: true}).click();
    await card.locator('input[type="search"]').fill('github.com');
    const github = card.locator('[data-adaptation-rule="github"]');
    await github.locator('.el-switch').click();
    await waitForAsyncCondition(() => options.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
      return config.siteAdaptation.disabledRuleIds.includes('github');
    }, undefined), {timeoutMs: timeout, message: "GitHub 内置适配规则未持久化为禁用"});
    await github.locator('.el-switch').click();
    await waitForAsyncCondition(() => options.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
      return !config.siteAdaptation.disabledRuleIds.includes('github');
    }, undefined), {timeoutMs: timeout, message: "GitHub 内置适配规则未持久化为启用"});
    await github.getByRole('button', {name: /GitHub/}).click();
    await card.getByRole('button', {name: '复制到自定义草稿', exact: true}).click();
    assert.ok(JSON.parse(await card.locator('textarea').inputValue()).rules.some(rule => rule.id === 'github'));
    await card.getByRole('button', {name: '撤销草稿替换', exact: true}).click();
    assert.equal(JSON.parse(await card.locator('textarea').inputValue()).rules.length, 1);
    report.ui.builtinSearchDisableCopy = true;
    await card.getByText('查看内置规则', {exact: true}).click();
    await options.screenshot({path: path.join(artifactsDir, 'settings-desktop.png'), caret: 'initial'});
    await options.setViewportSize({width: 390, height: 820});
    await card.evaluate(element => element.scrollIntoView({block: 'start'}));
    await options.waitForTimeout(200);
    report.ui.mobileOverflow = await options.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(report.ui.mobileOverflow, false);
    await options.screenshot({path: path.join(artifactsDir, 'settings-mobile.png'), caret: 'initial'});
    await card.locator('textarea').scrollIntoViewIfNeeded();
    await options.screenshot({path: path.join(artifactsDir, 'settings-mobile-editor.png'), caret: 'initial'});
    await options.setViewportSize({width: 1280, height: 900});
    }
    await configPatch({siteAdaptation: {enabled: true, disabledRuleIds: [], custom: isLive ? {version: 1, rules: []} : customPack}});
    const page = await helper.newPageWithoutForeground(context); await attach(page);
    testPage = page;
    for (const item of cases) {
      try { await runCase(page, item); }
      catch (error) {
        const artifactName = item.variant ? `${item.id}-${item.variant}` : item.id;
        assert.match(artifactName, /^[a-zA-Z0-9_-]+$/u, 'Unsafe fixture artifact name');
        report.fixtureCases.push({id: item.id, ...(item.variant ? {variant: item.variant} : {}), stage: item.stage, error: error.message, diagnostics: await page.evaluate(() => ({url: location.href, targets: [...document.querySelectorAll('[data-reading-check]')].map(node => node.outerHTML.slice(0, 1500)), wrappers: [...document.querySelectorAll('.fluent-read-bilingual-content')].map(node => ({parent: node.parentElement.id, text: node.textContent})), retries: document.querySelectorAll('.fluent-read-retry-wrapper').length}))});
        await fs.promises.writeFile(path.join(artifactsDir, `${artifactName}-failed.html`), await page.content());
        await fs.promises.writeFile(path.join(artifactsDir, `${artifactName}-failed-requests.json`), JSON.stringify(await worker.evaluate(() => globalThis.__adaptationRequests), null, 2));
        await page.screenshot({path: path.join(artifactsDir, `${artifactName}-failed.png`), caret: 'initial'});
        if (!isLive) throw error;
        fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
      }
    }
    report.translationRequests = await worker.evaluate(() => globalThis.__adaptationRequests.length);
    if (!isLive) assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.success = report.fixtureCases.every(item => !item.error);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    report.ownedBrowserClosed = false;
    report.temporaryProfileRemoved = false;
    if (runtimeStarted) {
      await cleanup(async () => {
        report.runtimeUnload = await unloadRuntimePage(testPage, runtimeDiagnostics, 'site-adaptation-unload');
      });
      await cleanup(async () => {
        const result = {ok: true};
        const failures = await finishRuntimeDiagnostics(runtimeDiagnostics, result, artifactsDir);
        report.runtimeDiagnostics = result.runtimeDiagnostics;
        if (failures.length) throw new AggregateError(failures.map(({error}) => error), 'Site adaptation runtime diagnostics failed');
      });
    }
    await cleanup(async () => {
      if (session) {await session.close(); browserClosed = true; report.ownedBrowserClosed = true;}
    });
    await cleanup(() => {
      if (!profileDir) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
      report.temporaryProfileRemoved = !fs.existsSync(profileDir);
    });
    if (cleanupErrors.length) {
      report.success = false;
      report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
    }
    await cleanup(() => {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}
main().then(() => { console.log(JSON.stringify({success: report.success, passed: report.fixtureCases.filter(item => !item.error).length, total: report.fixtureCases.length, report: path.join(artifactsDir, 'report.json')})); if (!report.success) process.exitCode = 1; }).catch(error => {console.error(error.stack); process.exitCode = 1;});
