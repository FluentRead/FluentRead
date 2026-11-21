#!/usr/bin/env node
'use strict';
// 译文样式生产回归：临时配置、第二屏后台窗口、本地确定性译文，验证界面风格页的样式卡片、外观微调与网页实时生效。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const argument = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const subset = (actual, expected) => expected && typeof expected === 'object' && !Array.isArray(expected)
  ? actual && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  : JSON.stringify(actual) === JSON.stringify(expected);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertScaled = (actual, base, scale, label) => assert(Math.abs(Number.parseFloat(actual) - Number.parseFloat(base) * scale) < 0.05, `${label}: ${actual} vs ${base} × ${scale}`);
const SOURCE = 'Reading should feel calm and effortless. Colors and lines should follow the page you are reading.';
const TRANSLATION = '阅读应该轻松、自然。颜色和线条应当贴合你正在阅读的网页。';
const DEFAULT_APPEARANCE = {textColor: '', backgroundColor: '', lineColor: '', fillColor: '', fontScale: 100, fontWeight: 'default', fontFamily: 'default', opacity: 100, customCss: ''};
const EXPECTED_CATEGORY_COUNTS = {文字: 12, 颜色: 12, 线条: 14, 标记: 9, 卡片: 12, 趣味: 12};
const TEXT_COLOR_PRESETS = [
  {value: 49, label: '森林绿', hex: '#007824', baseWeight: 0.4},
  {value: 50, label: '澄澈蓝', hex: '#1d4ed8'},
  {value: 51, label: '优雅紫', hex: '#6d28d9'},
  {value: 52, label: '暖橙', hex: '#b45309'},
  {value: 53, label: '青碧', hex: '#0f766e'},
  {value: 54, label: 'FluentRead 粉', hex: '#ef4776'},
  {value: 55, label: '莓果红', hex: '#be123c'},
  {value: 56, label: '暖金', hex: '#a16207'},
  {value: 57, label: '石墨灰', hex: '#475569'},
  {value: 40, label: '渐变文字'},
  {value: 41, label: '霓虹微光'},
  {value: 42, label: '彩虹荧光'},
];

async function checkTextColors({options, page, group, preview, readConfig, patchConfig, untilConfig, shot, report, fixture, context, activate}) {
  const card = value => options.locator(`.translation-style-card[data-style-value="${value}"]`);
  const settle = () => options.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readColor = locator => locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const drawing = canvas.getContext('2d', {willReadFrequently: true});
    const rgba = color => {drawing.clearRect(0, 0, 1, 1); drawing.fillStyle = color; drawing.fillRect(0, 0, 1, 1); return [...drawing.getImageData(0, 0, 1, 1).data];};
    const rgb = color => rgba(color).slice(0, 3);
    const blend = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] / 255 + background[index] * (1 - foreground[3] / 255));
    const layers = []; for (let current = element; current; current = current.parentElement) layers.unshift(rgba(getComputedStyle(current).backgroundColor));
    const background = layers.reduce((result, layer) => blend(layer, result), [255, 255, 255]);
    const style = getComputedStyle(element);
    const inner = element.querySelector('.fluent-read-translation-text');
    const stops = image => [...image.matchAll(/(?:rgba?|color)\([^)]*\)/gu)].map(match => rgba(match[0]));
    const foregroundStops = style.webkitTextFillColor === 'rgba(0, 0, 0, 0)' ? stops(style.backgroundImage) : [rgba(style.color)];
    const markerStops = inner ? stops(getComputedStyle(inner).backgroundImage) : [];
    const backgrounds = markerStops.length ? markerStops.map(stop => blend(stop, background)) : [background];
    const interpolate = values => values.length < 2 ? values : values.flatMap((value, index) => index === values.length - 1 ? [value]
      : Array.from({length: 101}, (_, step) => value.map((channel, key) => channel + (values[index + 1][key] - channel) * step / 100)));
    const luminance = color => color.slice(0, 3).map(value => {const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;})
      .reduce((result, value, index) => result + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (foreground, background) => {const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);};
    const contrasts = interpolate(foregroundStops).flatMap(foreground => interpolate(backgrounds).map(background => contrast(foreground, background)));
    return {color: style.color, rgb: rgb(style.color), parentRgb: rgb(getComputedStyle(element.parentElement).color), className: element.className,
      backgroundRgb: background, backgroundImage: style.backgroundImage, textFillColor: style.webkitTextFillColor, textShadow: style.textShadow,
      markerBackgroundImage: inner ? getComputedStyle(inner).backgroundImage : 'none',
      foregroundStops, markerStops, minimumContrast: Math.min(...contrasts)};
  });
  const assertColor = async (locator, preset, label) => {
    const actual = await readColor(locator);
    if (preset.hex) {
      const base = preset.hex.slice(1).match(/../gu).map(value => Number.parseInt(value, 16));
      const baseWeight = preset.baseWeight ?? 0.6;
      const expected = base.map((value, index) => Math.round(value * baseWeight + actual.parentRgb[index] * (1 - baseWeight)));
      const matches = actual.rgb.every((value, index) => Math.abs(value - expected[index]) <= 1);
      if (!matches) {report.metrics.failedColor = {label, expected, actual}; await shot(group, `failure-${label.replace(/[^a-z0-9]+/giu, '-')}`);}
      assert(matches, `${label}: ${JSON.stringify(actual)} vs ${expected}`);
    } else if (preset.value === 40) {
      assert(actual.foregroundStops.length >= 3 && actual.backgroundImage.includes('linear-gradient'), `${label} needs visible gradient text`);
    } else if (preset.value === 41) assert.notEqual(actual.textShadow, 'none', `${label} needs a neon glow`);
    else if (preset.value === 42) assert(actual.markerStops.length >= 5, `${label} needs rainbow marker colors`);
    if (actual.minimumContrast < 4.5) {report.metrics.failedColor = {label, actual}; await shot(group, `failure-${label.replace(/[^a-z0-9]+/giu, '-')}`);}
    assert(actual.minimumContrast >= 4.5, `${label} contrast ${actual.minimumContrast} below 4.5 on fixture background`);
    return actual;
  };

  // 旧配置保留稳定编号及已有微调；新增卡片不迁移或改写用户的选择。
  assert.equal(await card(6).getAttribute('aria-checked'), 'true');
  assert.match(await preview.getAttribute('class'), /fluent-display-wavy/u);
  assert.equal((await readColor(preview)).color, 'rgb(71, 85, 105)');
  await options.reload({waitUntil: 'domcontentloaded'});
  await group.waitFor({state: 'visible'});
  assert.equal(await card(6).getAttribute('aria-checked'), 'true');
  assert(subset((await readConfig()).translationAppearance, {textColor: '#475569', fontScale: 110}));
  await shot(group, 'colors-01-existing-style-preserved');
  const conflictingAppearance = {...DEFAULT_APPEARANCE, textColor: '#ef4776', fontScale: 117, fontWeight: 'bold', fontFamily: 'serif',
    customCss: 'color: #ef4776; font-size: 117%; letter-spacing: 1px; border-radius: 9px;'};
  await patchConfig({style: 0, translationAppearance: conflictingAppearance});
  await options.locator('.translation-style-categories').getByRole('radio', {name: '文字', exact: true}).click();
  assert.equal(await options.locator('.translation-style-card').count(), 12, 'original text category keeps its twelve presets');
  assert.equal(await card(49).count(), 0, 'color presets should have their own category');
  const categories = options.locator('.translation-style-categories');
  assert.deepEqual((await categories.getByRole('radio').allTextContents()).map(text => text.trim()), Object.keys(EXPECTED_CATEGORY_COUNTS));
  const colorCategory = categories.getByRole('radio', {name: '颜色', exact: true});
  await colorCategory.click();
  assert.equal(await colorCategory.getAttribute('aria-checked'), 'true');
  assert.deepEqual(await options.locator('.translation-style-card').evaluateAll(elements => elements.map(element => Number(element.dataset.styleValue))), TEXT_COLOR_PRESETS.map(preset => preset.value));
  report.metrics.categoryCounts = {文字: 12, 颜色: 12};
  const independentCards = {};
  for (const preset of TEXT_COLOR_PRESETS) independentCards[preset.value] = await assertColor(card(preset.value).locator('.fluent-read-bilingual-content'), preset, `independent card ${preset.value}`);
  assert.equal(new Set(TEXT_COLOR_PRESETS.filter(preset => preset.hex).map(preset => independentCards[preset.value].rgb.join(','))).size, 9, 'nine solid cards must keep their own colors under a pink override');
  report.metrics.independentCards = independentCards;
  await shot(group, 'colors-01b-pink-config-independent-cards');
  await card(49).click();
  await untilConfig(config => config.style === 49 && !config.translationAppearance.textColor && !/(?:^|;)\s*color\s*:/iu.test(config.translationAppearance.customCss), 'green clears old pink and CSS color');
  await settle();
  await assertColor(preview, TEXT_COLOR_PRESETS[0], 'pink override then green click');
  const clearedAppearance = (await readConfig()).translationAppearance;
  assert(subset(clearedAppearance, {fontScale: 117, fontWeight: 'bold', fontFamily: 'serif'}));
  assert.match(clearedAppearance.customCss, /letter-spacing:\s*1px/u);
  assert.match(clearedAppearance.customCss, /border-radius:\s*9px/u);
  const preservedTypography = await preview.evaluate(element => {const style = getComputedStyle(element); return {weight: style.fontWeight, family: style.fontFamily, spacing: style.letterSpacing, radius: style.borderRadius};});
  assert.equal(preservedTypography.weight, '700'); assert.match(preservedTypography.family, /serif/u);
  assert.equal(preservedTypography.spacing, '1px'); assert.equal(preservedTypography.radius, '9px');
  report.metrics.preservedTypography = preservedTypography;
  await shot(group, 'colors-01c-green-replaces-pink-preserves-typography');
  await patchConfig({translationAppearance: DEFAULT_APPEARANCE});
  report.metrics.textColors = {};
  for (const theme of ['light', 'dark']) {
    await group.locator('.translation-style-preview-theme').getByRole('radio', {name: theme === 'light' ? '浅色网页' : '深色网页', exact: true}).click();
    await wait(220); await settle();
    for (const preset of TEXT_COLOR_PRESETS) {
      const target = card(preset.value);
      assert.equal(await target.getAttribute('aria-label'), preset.label);
      if (preset.value === 40) await patchConfig({translationAppearance: {...DEFAULT_APPEARANCE, textColor: '#ef4776', backgroundColor: '#fff8cc', customCss: 'color: #ef4776; background: #fff8cc;'}});
      if (preset.value === 41) await patchConfig({translationAppearance: {...DEFAULT_APPEARANCE, textColor: '#ef4776', customCss: 'color: #ef4776; text-shadow: none;'}});
      await target.click();
      await untilConfig(config => config.style === preset.value && !config.translationAppearance.textColor, `text preset ${preset.value}`);
      await settle();
      assert.equal(await target.getAttribute('aria-checked'), 'true');
      const sample = await assertColor(target.locator('.fluent-read-bilingual-content'), preset, `${theme} card ${preset.value}`);
      const live = await assertColor(preview, preset, `${theme} preview ${preset.value}`);
      report.metrics.textColors[`${theme}-${preset.value}`] = {sample, preview: live};
    }
    await card(49).click(); await untilConfig(config => config.style === 49); await settle();
    await shot(group, `colors-02-${theme}-twelve-presets-green-selected`);
  }
  await group.locator('.translation-style-preview-theme').getByRole('radio', {name: '浅色网页', exact: true}).click();
  await wait(220); await settle();
  const roundTrip = {};
  for (const preset of TEXT_COLOR_PRESETS) roundTrip[preset.value] = await assertColor(card(preset.value).locator('.fluent-read-bilingual-content'), preset, `dark to light card ${preset.value}`);
  await assertColor(preview, TEXT_COLOR_PRESETS[0], 'dark to light green preview');
  report.metrics.darkToLightCards = roundTrip;
  report.checks.push('existing style 6 survives reopening; Text keeps 12 presets and Colors contains 12 stable IDs in the six-tab order');
  report.checks.push('pink text and CSS override do not recolor color cards; selecting green clears conflicting color while preserving typography and other CSS');
  report.checks.push('all 12 color presets render in light/dark cards and preview, with sampled contrast at least 4.5 on the specified fixture backgrounds');
  report.checks.push('dark-to-light round trip refreshes all mounted color cards and the green preview without remounting');
  report.metrics.readabilityMethod = 'Computed sRGB foreground/background; alpha-composited marker stops and 101 samples per adjacent gradient-stop pair. Threshold 4.5 applies to these light/dark fixture colors with default opacity, not arbitrary websites or custom overrides.';

  // 新预设只保存稳定 ID；品牌色板可给任何旧样式指定相同的精确文字色。
  await card(54).click(); await untilConfig(config => config.style === 54);
  await options.reload({waitUntil: 'domcontentloaded'}); await group.waitFor({state: 'visible'});
  assert.equal(await colorCategory.getAttribute('aria-checked'), 'true', 'reopening a color preset should select Colors');
  assert.equal(await options.locator('.translation-style-card').count(), 12);
  assert.equal(await card(54).getAttribute('aria-checked'), 'true');
  await assertColor(preview, TEXT_COLOR_PRESETS[5], 'reopened brand preset');
  assert.equal((await readConfig()).translationAppearance.textColor, '');
  await card(49).click(); await untilConfig(config => config.style === 49);
  await options.locator('.translation-appearance-disclosure').click();
  const textField = options.locator('[data-color-field="translation-text-color"]');
  const brand = textField.locator('button[data-color="#ef4776"]');
  assert.match(await brand.getAttribute('aria-label'), /FluentRead/u);
  await brand.focus(); await options.keyboard.press('Space');
  await untilConfig(config => config.translationAppearance.textColor === '#ef4776', 'keyboard brand swatch');
  await settle();
  assert.equal(await brand.getAttribute('aria-checked'), 'true');
  assert.equal((await readColor(preview)).color, 'rgb(239, 71, 118)');
  await assertColor(card(49).locator('.fluent-read-bilingual-content'), TEXT_COLOR_PRESETS[0], 'green card keeps own color after optional pink fine-tuning');
  await shot(group, 'colors-03-optional-brand-fine-tuning-cards-stay-original');
  await options.reload({waitUntil: 'domcontentloaded'}); await group.waitFor({state: 'visible'});
  assert.equal(await colorCategory.getAttribute('aria-checked'), 'true', 'reopening a customized color preset should select Colors');
  assert.equal(await card(49).getAttribute('aria-checked'), 'true');
  await options.locator('.translation-appearance-disclosure').click();
  assert.equal(await brand.getAttribute('aria-checked'), 'true');
  assert.equal((await readColor(preview)).color, 'rgb(239, 71, 118)');
  await textField.getByRole('radio', {name: '默认', exact: true}).click();
  await untilConfig(config => !config.translationAppearance.textColor, 'restore preset text color');
  await settle(); await assertColor(preview, TEXT_COLOR_PRESETS[0], 'default restores green');
  await shot(group, 'colors-04-green-restored-palette');
  report.checks.push('brand preset and keyboard-selected brand swatch persist after reopening; Default restores the green preset color');

  await card(40).click(); await untilConfig(config => config.style === 40);
  await assertColor(preview, TEXT_COLOR_PRESETS.find(preset => preset.value === 40), 'gradient restored before optional text color');
  await brand.click(); await untilConfig(config => config.translationAppearance.textColor === '#ef4776');
  await settle();
  const gradientOverride = await readColor(preview);
  assert.equal(gradientOverride.color, 'rgb(239, 71, 118)');
  assert.equal(gradientOverride.textFillColor, 'rgb(239, 71, 118)', 'explicit text color must override transparent gradient fill');
  report.metrics.gradientTextColorOverride = gradientOverride;
  await shot(group, 'colors-04b-gradient-explicit-text-color');
  await card(49).click(); await untilConfig(config => config.style === 49 && !config.translationAppearance.textColor);
  report.checks.push('explicit text color after selecting Gradient text updates both computed color and webkit text fill; selecting green restores its own color');

  await options.locator('.translation-appearance-disclosure').click();
  const layouts = {};
  for (const width of [1024, 820, 390]) {
    await options.setViewportSize({width, height: 960}); await wait(220);
    layouts[width] = await options.evaluate(() => {
      const group = document.querySelector('.translation-style-group').getBoundingClientRect();
      const categories = document.querySelector('.translation-style-categories');
      const rect = categories.getBoundingClientRect();
      return {innerWidth, scrollWidth: document.documentElement.scrollWidth, groupWidth: group.width,
        gridScrollWidth: document.querySelector('.translation-style-grid').scrollWidth,
        gridWidth: document.querySelector('.translation-style-grid').clientWidth,
        categoriesWidth: categories.clientWidth, categoriesScrollWidth: categories.scrollWidth,
        categoriesInsideGroup: rect.left >= group.left - 1 && rect.right <= group.right + 1};
    });
    assert(layouts[width].scrollWidth <= width + 1, `${width}px document overflow`);
    assert(layouts[width].gridScrollWidth <= layouts[width].gridWidth + 1, `${width}px preset overflow`);
    assert(layouts[width].categoriesScrollWidth <= layouts[width].categoriesWidth + 1 && layouts[width].categoriesInsideGroup, `${width}px six-category overflow`);
  }
  await shot(group, 'colors-05-mobile-green-presets');
  await options.locator('.translation-appearance-disclosure').click();
  await brand.click(); await untilConfig(config => config.translationAppearance.textColor === '#ef4776');
  const palette = options.locator('#translation-appearance-panel');
  assert(await palette.evaluate(element => element.scrollWidth <= element.clientWidth + 1), '390px palette overflow');
  await shot(palette, 'colors-06-mobile-brand-palette');
  report.metrics.layouts = layouts;
  report.checks.push('1024/820/390 widths have no page, preset or six-category overflow; mobile palette remains inside its panel');

  await card(49).click(); await untilConfig(config => config.style === 49 && !config.translationAppearance.textColor);
  await patchConfig({uiLanguage: 'en-US'});
  await options.reload({waitUntil: 'domcontentloaded'}); await group.waitFor({state: 'visible'});
  const englishColors = categories.getByRole('radio', {name: 'Colors', exact: true});
  await englishColors.waitFor({state: 'visible'});
  await categories.getByRole('radio', {name: 'Text', exact: true}).click();
  assert.equal(await options.locator('.translation-style-card').count(), 12);
  await englishColors.click();
  assert.equal(await englishColors.getAttribute('aria-checked'), 'true');
  assert.equal(await options.locator('.translation-style-card').count(), 12);
  await assertColor(preview, TEXT_COLOR_PRESETS[0], 'English reopened Forest green is green');
  const englishTabs = await categories.getByRole('radio').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    return {label: element.textContent.trim(), x: box.x, y: box.y, right: box.right, bottom: box.bottom,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      textLineCount: lines.length,
      textInside: lines.length > 0 && lines.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1)};
  }));
  assert.equal(englishTabs.length, 6);
  assert(englishTabs.every(tab => tab.textInside && tab.textLineCount === 1 && tab.scrollWidth <= tab.clientWidth + 1), JSON.stringify(englishTabs));
  for (let index = 0; index < englishTabs.length; index++) for (const other of englishTabs.slice(index + 1)) {
    const tab = englishTabs[index];
    const overlap = Math.min(tab.right, other.right) - Math.max(tab.x, other.x) > 0.5
      && Math.min(tab.bottom, other.bottom) - Math.max(tab.y, other.y) > 0.5;
    assert(!overlap, `${tab.label} overlaps ${other.label}`);
  }
  report.metrics.english390Tabs = englishTabs;
  await shot(group, 'colors-06b-mobile-en-color-tab');
  report.checks.push('English 390px Colors tab opens all 12 colors with a green preview; whole category labels stay on one text line and buttons wrap without clipping or overlap');

  // 真实内容脚本配合本地确定性服务，验证新颜色不只存在于设置预览。
  await page.setViewportSize({width: 1440, height: 960});
  const pageColors = {};
  for (const preset of [TEXT_COLOR_PRESETS[0], TEXT_COLOR_PRESETS[5]]) {
    await patchConfig({style: preset.value, translationAppearance: DEFAULT_APPEARANCE, bilingualSentenceHighlightEnabled: false});
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await activate(context, page, 30000);
    await page.locator('#primary').hover(); await page.keyboard.down('Control'); await page.keyboard.up('Control');
    const translated = page.locator('#primary > .fluent-read-bilingual-content');
    await translated.waitFor({state: 'attached'});
    await page.waitForFunction(() => document.querySelector('#primary > .fluent-read-bilingual-content')?.textContent.includes('阅读应该轻松'));
    pageColors[preset.value] = await assertColor(translated, preset, `web page ${preset.value}`);
    await shot(page, `colors-07-page-${preset.value === 49 ? 'green' : 'brand'}`);
  }
  report.metrics.pageColors = pageColors;
  assert(fixture.requests.length >= 2, 'fixture should handle both translated pages');
  report.checks.push('real content script renders readable green and brand pink on locally translated paragraphs');
}

async function startFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body;
      try {body = JSON.parse(Buffer.concat(chunks).toString());}
      catch {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: {message: 'Invalid synthetic fixture JSON'}})); return;}
      if (body === null || !Array.isArray(body.messages) || body.messages.some(item => item === null)) {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: {message: 'Invalid synthetic fixture request'}})); return;}
      const prompt = body.messages.filter(item => item.role === 'user').map(item => item.content).join('\n');
      const text = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1] || '';
      requests.push({source: text});
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({id: 'translation-style-fixture', object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{index: 0, message: {role: 'assistant', content: text.replace(SOURCE, TRANSLATION)}, finish_reason: 'stop'}]}));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Translation style fixture</title><style>body{margin:0;padding:48px 8vw;font:18px/1.8 system-ui;color:#263044;background:#fff}main{max-width:900px}p{margin:28px 0}</style></head><body><main><h1 translate="no">Translation style fixture</h1><p id="primary">${SOURCE}</p></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); server.close(() => reject(error)); server.closeAllConnections();};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  return {url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}

async function main() {
  const textColorsOnly = process.argv.includes('--text-colors-only');
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-translation-style'));
  const packages = argument('playwright-root'); const helperPath = argument('focus-safe-helper');
  assert(packages && helperPath, '需要 --playwright-root 与 --focus-safe-helper'); assert(fs.existsSync(path.join(extensionDir, 'manifest.json')));
  const {chromium} = require(require.resolve('playwright', {paths: [packages]}));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication} = require(helperPath);
  let profileDir; let launchAttempted = false;
  fs.mkdirSync(artifactsDir, {recursive: true});
  let fixture;
  const report = {ok: false, scope: textColorsOnly ? 'translation-text-colors' : 'translation-style', extensionDir, profileDir, artifactsDir, checks: [], consoleErrors: [], screenshots: [], metrics: {},
    evidenceBoundary: 'Local deterministic HTML/provider in an isolated Edge profile; no Firefox runtime or external provider claim.'};
  let launched;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-translation-style-edge-'));
    report.profileDir = profileDir;
    fixture = await startFixture();
    report.foregroundBefore = await queryMacFrontmostApplication();
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false, displayTarget: 'secondary',
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    const createPage = async url => {
      const result = await newPageWithoutForeground(context, 30000);
      await result.setViewportSize({width: 1440, height: 960});
      result.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
      result.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`console: ${message.text()}`); });
      await result.goto(url, {waitUntil: 'domcontentloaded'}); return result;
    };
    const shot = async (surface, name) => {
      const owner = typeof surface.page === 'function' ? surface.page() : surface;
      const viewport = owner.viewportSize();
      let expanded = false;
      if (surface !== owner) {
        // 设置页在内部容器中滚动；让整组真实进入视口再截图，避免截图把被裁剪的区域渲染成空白。
        const height = Math.ceil(await surface.evaluate(element => element.getBoundingClientRect().height));
        // 手机设置页顶部还有固定导航；额外留出空间，确保组底部不会被内部滚动视口裁切。
        if (height + 400 > viewport.height) {
          await owner.setViewportSize({width: viewport.width, height: height + 400});
          expanded = true;
        }
        await surface.scrollIntoViewIfNeeded();
      }
      const file = path.join(artifactsDir, `${name}.png`);
      await surface.screenshot({path: file}); report.screenshots.push(file);
      if (expanded) await owner.setViewportSize(viewport);
    };
    const popup = await createPage(`${origin}/popup.html`);
    const readConfig = () => popup.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!result?.success) throw new Error(result?.error); return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    });
    const untilConfig = async (predicate, label = 'configuration') => {
      for (let i = 0; i < 200; i++) {const config = await readConfig(); if (config && predicate(config)) return config; await wait(50);}
      throw new Error(`${label} did not converge`);
    };
    await untilConfig(config => config.to && config.service);
    const patchConfig = async patch => {
      const current = await readConfig(); const initial = Object.hasOwn(patch, 'token');
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const result = await popup.evaluate(({patch, current, expected, initial}) => chrome.runtime.sendMessage({
        type: 'persistConfig', mode: initial ? 'replace' : 'patch', config: initial ? {...current, ...patch} : patch, expected,
        baseRevision: initial ? current.__fluentConfigRevision : undefined, clientId: `translation-style-${crypto.randomUUID()}`, sequence: 1,
      }), {patch, current, expected, initial});
      assert.equal(result?.success, true, result?.error);
      await untilConfig(config => Object.keys(patch).filter(key => key !== 'token').every(key => subset(config[key], patch[key])));
    };
    const service = 'custom:translation-style-fixture';
    await patchConfig({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, theme: 'light', interfaceSkin: 'default',
      display: 1, style: textColorsOnly ? 6 : 1,
      translationAppearance: textColorsOnly ? {...DEFAULT_APPEARANCE, textColor: '#475569', fontScale: 110} : DEFAULT_APPEARANCE,
      service, from: 'en', to: 'zh-Hans', useCache: false,
      autoTranslate: false, bilingualSentenceHighlightEnabled: false, translationBeforeOriginal: false,
      customOpenAIProviders: [{id: service, name: '译文样式夹具', endpoint: `${fixture.url}/v1/chat/completions`, models: ['fixture']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'fixture'},
      user_role: {[service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
      glossaryEnabled: false, hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0,
      selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, animations: false});

    // 在界面交互前创建网页页签，避免设置页多次重排后再创建窗口导致 Edge 抢占前台。
    const page = await createPage(`${fixture.url}/article`);

    // 1. 设置页：通用设置只保留入口，界面风格第一组是译文样式。
    const options = await createPage(`${origin}/options.html#settings-general`);
    await options.setViewportSize({width: 1440, height: 960});
    const openStyle = options.getByTestId('open-translation-style-settings');
    await openStyle.waitFor({state: 'visible'});
    const general = options.locator('#settings-general');
    assert.equal(await general.locator('[data-testid="bilingual-highlight-preview"]').count(), 0, '通用设置仍保留旧预览');
    assert.equal(await general.getByRole('combobox', {name: '译文样式'}).count(), 0, '通用设置仍保留旧下拉框');
    await openStyle.click();
    await options.waitForFunction(() => location.hash === '#settings-interface');
    const root = options.getByTestId('translation-style-settings');
    await root.waitFor({state: 'visible'});
    const firstGroup = (await options.locator('#settings-interface .settings-group-heading h2').first().innerText()).trim();
    assert.equal(firstGroup, '译文样式', `界面风格第一组应为译文样式，实际为 ${firstGroup}`);
    report.checks.push('general links to interface; translation style is the first interface group');
    const group = options.locator('.translation-style-group');
    const preview = group.getByTestId('bilingual-highlight-preview-translation');
    await options.mouse.move(0, 0);
    if (textColorsOnly) {
      await checkTextColors({options, page, group, preview, readConfig, patchConfig, untilConfig, shot, report, fixture, context,
        activate: activateExtensionTabWithoutForeground});
      assert.deepEqual(report.consoleErrors, []);
      report.requests = fixture.requests.length; report.ok = true;
      return;
    }
    await shot(group, '01-desktop-light-default');

    // 2. 分类数量与逐个选择：每个样式都即时反映到预览并写入配置。
    const categoryCounts = {};
    for (const [category, expectedCount] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
      await options.locator('.translation-style-categories').getByRole('radio', {name: category, exact: true}).click();
      const cards = options.locator('.translation-style-card');
      categoryCounts[category] = await cards.count();
      assert.equal(categoryCounts[category], expectedCount, `${category} 分类的样式数量异常`);
      for (let index = 0; index < categoryCounts[category]; index++) {
        const card = cards.nth(index);
        const value = Number(await card.getAttribute('data-style-value'));
        await card.click();
        await untilConfig(config => config.style === value, `style ${value}`);
        assert.equal(await card.getAttribute('aria-checked'), 'true');
        const sampleClass = await card.locator('.fluent-read-bilingual-content').getAttribute('class');
        const previewClass = await preview.getAttribute('class');
        const presetClass = sampleClass.split(/\s+/u).find(name => name.startsWith('fluent-display-'));
        assert(previewClass.split(/\s+/u).includes(presetClass), `预览没有应用 ${presetClass}`);
      }
      await shot(group, `02-category-${category}`);
    }
    report.metrics.categoryCounts = categoryCounts;
    report.checks.push('71 preset cards across six categories update preview and persisted style');

    // 3. 外观微调：色板、键盘、滑块、分段控件与自定义取色器全部写入配置，并由预览按网页规则计算。
    await options.locator('.translation-style-categories').getByRole('radio', {name: '线条', exact: true}).click();
    await options.locator('.translation-style-card[data-style-value="6"]').click();
    await untilConfig(config => config.style === 6);
    await options.locator('.translation-appearance-disclosure').click();
    const textField = options.locator('[data-color-field="translation-text-color"]');
    await textField.getByRole('radio', {name: '默认', exact: true}).focus();
    await options.keyboard.press('ArrowRight');
    await untilConfig(config => config.translationAppearance?.textColor === '#1f2937', 'keyboard text color');
    await textField.locator('button[data-color="#1d4ed8"]').click();
    await options.locator('[data-color-field="translation-line-color"] button[data-color="#ef4776"]').click();
    await options.locator('[data-color-field="translation-fill-color"] button[data-color="#4ade80"]').click();
    const ranges = options.locator('.translation-appearance-range input[type="range"]');
    const setRange = (locator, value) => locator.evaluate((element, next) => {
      element.value = next; element.dispatchEvent(new Event('input', {bubbles: true}));
    }, String(value));
    await setRange(ranges.nth(0), 115);
    await setRange(ranges.nth(1), 80);
    await options.locator('.translation-appearance-choice').nth(0).getByRole('radio', {name: '加粗', exact: true}).click();
    await options.locator('.translation-appearance-choice').nth(1).getByRole('radio', {name: '衬线', exact: true}).click();
    const backgroundField = options.locator('[data-color-field="translation-background-color"]');
    const backgroundInput = backgroundField.locator('.translation-color-value');
    await backgroundInput.fill('rgb(255, 248, 204)'); await backgroundInput.press('Enter');
    const textInput = textField.locator('.translation-color-value');
    await textInput.fill('rebeccapurple'); await textInput.press('Enter');
    await untilConfig(config => config.translationAppearance?.textColor === '#663399', 'named text color');
    await textInput.fill('rgb(29, 78, 216)'); await textInput.press('Enter');
    const fontScaleInput = options.getByTestId('translation-font-scale-value');
    await fontScaleInput.fill('117'); await fontScaleInput.press('Tab');
    await untilConfig(config => subset(config.translationAppearance, {textColor: '#1d4ed8', lineColor: '#ef4776', fillColor: '#4ade80',
      backgroundColor: '#fff8cc', fontScale: 117, opacity: 80, fontWeight: 'bold', fontFamily: 'serif'}), 'appearance controls');
    await textInput.fill('banana'); await textInput.press('Enter');
    assert.equal(await textInput.getAttribute('aria-invalid'), 'true');
    assert.equal((await readConfig()).translationAppearance.textColor, '#1d4ed8', 'invalid color should not be saved');
    await textInput.fill('rgb(29, 78, 216)'); await textInput.press('Enter');
    const previewStyle = await preview.evaluate(element => {
      const style = getComputedStyle(element);
      return {color: style.color, backgroundColor: style.backgroundColor, decorationColor: style.textDecorationColor, fontSize: style.fontSize, fontWeight: style.fontWeight,
        opacity: style.opacity, fontFamily: style.fontFamily, parentFontSize: getComputedStyle(element.parentElement).fontSize};
    });
    assert.equal(previewStyle.color, 'rgb(29, 78, 216)');
    assert.equal(previewStyle.backgroundColor, 'rgb(255, 248, 204)');
    assert.equal(previewStyle.decorationColor, 'rgb(239, 71, 118)');
    assertScaled(previewStyle.fontSize, previewStyle.parentFontSize, 1.17, '预览字号');
    assert.equal(previewStyle.fontWeight, '700');
    assert.equal(previewStyle.opacity, '0.8');
    assert.match(previewStyle.fontFamily, /serif/u);
    report.metrics.previewStyle = previewStyle;
    assert.equal(await options.locator('.translation-style-preview-badge').count(), 1, '自定义后缺少已自定义标记');
    await shot(group, '03-desktop-custom-appearance');

    const pickerTrigger = textField.locator('.el-color-picker__trigger');
    await pickerTrigger.click();
    const dropdown = options.locator('.el-color-dropdown:visible');
    await dropdown.waitFor({state: 'visible'});
    const pickerInput = dropdown.locator('input').first();
    await pickerInput.fill('#123ABC'); await pickerInput.press('Enter');
    await dropdown.locator('.el-color-dropdown__btn').click();
    await untilConfig(config => config.translationAppearance?.textColor === '#123abc', 'custom color picker');
    assert.equal(await textField.locator('.translation-color-custom.selected').count(), 1, '自定义颜色没有点亮取色器');
    report.checks.push('swatches, color names, RGB, invalid input, exact percentage, sliders, segmented controls and custom picker persist appearance');

    const customCss = 'color: rebeccapurple; background: rgb(236, 253, 245); font-size: 117%; border-radius: 9px;';
    const cssEditor = options.locator('#translation-custom-css');
    await cssEditor.fill('color: red; position: fixed; background: url(https://example.com/x);');
    assert.equal(await cssEditor.getAttribute('aria-invalid'), 'true');
    await cssEditor.fill(customCss);
    await untilConfig(config => config.translationAppearance?.customCss === customCss, 'custom CSS saved');
    assert.equal(await cssEditor.getAttribute('aria-invalid'), 'false');
    const cssPreview = await preview.evaluate(element => ({
      color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
    }));
    assert.deepEqual(cssPreview, {color: 'rgb(102, 51, 153)', background: 'rgb(236, 253, 245)', radius: '9px'});
    await options.locator('#translation-profile-name').fill('CSS 阅读');
    await options.locator('.translation-profile-save').click();
    await untilConfig(config => config.translationStyleProfiles?.some(profile => profile.name === 'CSS 阅读' && profile.appearance.customCss === customCss), 'custom profile saved');
    const savedCard = options.locator('.translation-style-saved-card').filter({hasText: 'CSS 阅读'});
    const savedSample = await savedCard.locator('.fluent-read-bilingual-content').evaluate(element => ({
      color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
    }));
    assert.deepEqual(savedSample, cssPreview, 'saved style card should show its CSS effect');
    await shot(group, '03b-custom-css-and-saved-style');
    report.checks.push('direct CSS previews live, unsupported declarations are ignored, and saved style cards show their own effect');

    await group.locator('.translation-style-preview-theme').getByRole('radio', {name: '深色网页', exact: true}).click();
    // 网页配色切换带短暂淡入，等待计算样式稳定后再断言。
    await options.waitForFunction(() => getComputedStyle(document.querySelector('.translation-style-preview-page')).backgroundColor === 'rgb(23, 25, 30)');
    assert.equal(await options.locator('.translation-style-grid .translation-style-card-sample[data-page-theme="dark"]').count(), await options.locator('.translation-style-card').count());
    assert.equal(await savedCard.locator('.translation-style-card-sample[data-page-theme="dark"]').count(), 1);
    await shot(group, '04-desktop-dark-page');
    report.checks.push('preview switches between light and dark web pages');

    // 4. 仅译文模式提示可一键切回双语；逐句高亮在界面风格的阅读辅助分组中保存。
    await patchConfig({display: 0});
    const note = options.locator('.translation-style-mode-note');
    await note.waitFor({state: 'visible'});
    await note.getByRole('button').click();
    await untilConfig(config => config.display === 1, 'switch to bilingual');
    await note.waitFor({state: 'detached'});
    await options.goto(`${origin}/options.html#settings-translation`);
    const highlightSwitch = options.locator('#translation-sentence-highlight .el-switch');
    await highlightSwitch.click();
    await untilConfig(config => config.bilingualSentenceHighlightEnabled === true, 'sentence highlight toggle');
    await options.locator('.reading-assistance-example [data-testid="bilingual-highlight-preview-source"] span').nth(1).hover();
    assert.equal(await options.locator('.reading-assistance-example [data-testid="bilingual-highlight-preview"] .is-sentence-highlighted').count(), 2);
    await options.mouse.move(0, 0);
    report.checks.push('translation-only notice switches back; sentence highlight toggle and preview work in interface page');

    // 5. 重新打开设置页后，样式、外观与卡片分类均保持。
    await options.goto(`${origin}/options.html#settings-interface`);
    await options.reload({waitUntil: 'domcontentloaded'});
    await root.waitFor({state: 'visible'});
    await options.locator('.translation-appearance-disclosure').click();
    assert.equal(await savedCard.getAttribute('aria-checked'), 'true');
    assert.equal((await readConfig()).style, 6);
    assert.equal(await options.locator('[data-color-field="translation-line-color"] button[data-color="#ef4776"]').getAttribute('aria-checked'), 'true');
    assert.equal(await ranges.nth(0).inputValue(), '117');
    assert.equal(await fontScaleInput.inputValue(), '117');
    assert.equal(await backgroundInput.inputValue(), '#fff8cc');
    assert.equal(await cssEditor.inputValue(), customCss);
    const reopenedSample = await options.locator('.translation-style-saved-card .fluent-read-bilingual-content').first().evaluate(element => getComputedStyle(element).color);
    assert.equal(reopenedSample, 'rgb(102, 51, 153)');
    report.checks.push('settings reload keeps selected style and appearance');

    // 设置搜索直达：颜色关键词定位到自定义外观面板，逐句高亮定位并聚焦开关。
    const search = options.locator('.search-box input');
    await search.fill('线条颜色');
    await options.locator('.search-results button').first().click();
    await options.waitForFunction(() => {
      const rect = document.getElementById('translation-appearance-panel')?.getBoundingClientRect();
      return Boolean(rect && rect.top >= 0 && rect.top < innerHeight);
    });
    await search.fill('逐句高亮');
    await options.locator('.search-results button').first().click();
    await options.waitForFunction(() => Boolean(document.activeElement?.closest('#translation-sentence-highlight')));
    await options.goto(`${origin}/options.html#settings-interface`);
    await root.waitFor({state: 'visible'});
    await options.mouse.move(0, 0);
    report.checks.push('settings search jumps to the appearance panel and focuses the sentence highlight switch');

    // 6. 深色扩展界面与窄屏：无横向溢出，截图留证。
    await patchConfig({theme: 'dark'});
    await options.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await shot(group, '05-desktop-dark-ui');
    const layouts = {};
    for (const width of [1024, 820, 390]) {
      await options.setViewportSize({width, height: 900});
      await wait(200);
      layouts[width] = await options.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, innerWidth,
        groupWidth: document.querySelector('.translation-style-group')?.getBoundingClientRect().width}));
      assert(layouts[width].scrollWidth <= layouts[width].innerWidth + 1, `${width}px 出现横向溢出`);
      // 设置页在内部容器中滚动；临时加高视口，让整组内容完整进入截图。
      await options.setViewportSize({width, height: 3200});
      await wait(200);
      await shot(group, `06-width-${width}-dark-ui`);
    }
    report.metrics.layouts = layouts;
    await patchConfig({theme: 'light'});
    await options.setViewportSize({width: 1440, height: 960});
    report.checks.push('dark UI, 1024/820/390 widths render without horizontal overflow');

    // 7. 网页：真实悬浮翻译后，外观调整无需重译即可同步到已有译文，默认外观时移除样式节点。
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const appearanceNode = page.locator('#fluent-read-translation-appearance');
    assert.equal(await appearanceNode.count(), 1, '已有自定义外观时网页缺少外观样式节点');
    await patchConfig({translationAppearance: DEFAULT_APPEARANCE, style: 6, bilingualSentenceHighlightEnabled: false});
    await appearanceNode.waitFor({state: 'detached'});
    await activateExtensionTabWithoutForeground(context, page, 30000);
    await page.locator('#primary').hover(); await page.keyboard.down('Control'); await page.keyboard.up('Control');
    const translated = page.locator('#primary > .fluent-read-bilingual-content');
    await translated.waitFor({state: 'attached'});
    await page.waitForFunction(() => document.querySelector('#primary > .fluent-read-bilingual-content')?.textContent.includes('阅读应该轻松'));
    const requestCount = fixture.requests.length;
    const readTranslated = () => translated.evaluate(element => {
      const style = getComputedStyle(element);
      return {className: element.className, color: style.color, backgroundColor: style.backgroundColor, decorationColor: style.textDecorationColor, fontSize: style.fontSize,
        hostFontSize: getComputedStyle(element.parentElement).fontSize};
    });
    const before = await readTranslated();
    assert(before.className.includes('fluent-display-wavy'), before.className);
    assert.equal(before.decorationColor, 'rgb(64, 158, 255)');
    await shot(page, '07-page-default-wavy');
    await patchConfig({translationAppearance: {...DEFAULT_APPEARANCE, textColor: '#1d4ed8', backgroundColor: '#fff8cc', lineColor: '#ef4776', fontScale: 117}});
    await appearanceNode.waitFor({state: 'attached'});
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#primary > .fluent-read-bilingual-content')).textDecorationColor === 'rgb(239, 71, 118)');
    const after = await readTranslated();
    assert.equal(after.color, 'rgb(29, 78, 216)');
    assert.equal(after.backgroundColor, 'rgb(255, 248, 204)');
    assertScaled(after.fontSize, after.hostFontSize, 1.17, '网页译文字号');
    assert.equal(fixture.requests.length, requestCount, '外观调整不应重新请求翻译');
    await shot(page, '08-page-live-custom-appearance');
    await patchConfig({translationAppearance: {...DEFAULT_APPEARANCE, customCss}});
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#primary > .fluent-read-bilingual-content')).borderRadius === '9px');
    const cssPageStyle = await translated.evaluate(element => ({color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor, fontSize: getComputedStyle(element).fontSize,
      radius: getComputedStyle(element).borderRadius}));
    assert.equal(cssPageStyle.color, 'rgb(102, 51, 153)');
    assert.equal(cssPageStyle.background, 'rgb(236, 253, 245)');
    assert.equal(cssPageStyle.radius, '9px');
    assert.equal(fixture.requests.length, requestCount, 'CSS change should not request another translation');
    await shot(page, '08b-page-live-css');
    report.metrics.cssPageStyle = cssPageStyle;
    report.metrics.page = {before, after, requests: fixture.requests.length};
    // 关闭插件会恢复原文并移除外观节点；重新开启后按当前外观重新安装。
    await patchConfig({on: false});
    await appearanceNode.waitFor({state: 'detached'});
    await translated.waitFor({state: 'detached'});
    await patchConfig({on: true});
    await appearanceNode.waitFor({state: 'attached'});
    await patchConfig({translationAppearance: DEFAULT_APPEARANCE});
    await appearanceNode.waitFor({state: 'detached'});
    report.checks.push('page appearance and direct CSS update live without new requests; disable and default remove the style node');

    // 8. 简约卡片的底色不再被基础规则覆盖。
    await patchConfig({style: 7});
    await activateExtensionTabWithoutForeground(context, page, 30000);
    await page.locator('#primary').hover(); await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await translated.waitFor({state: 'attached'});
    const cardBackground = await translated.evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(cardBackground, 'rgba(64, 158, 255, 0.1)');
    await shot(page, '09-page-card-background');
    report.checks.push('card preset background renders on real pages');

    assert.deepEqual(report.consoleErrors, []);
    report.requests = fixture.requests.length; report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (launched) {
      try {await launched.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    report.browserClosed = closed;
    try {report.foregroundAfter = await queryMacFrontmostApplication();}
    catch (error) {report.cleanupErrors.push(`foreground observation: ${error.message}`);}
    try {await fixture?.close();} catch (error) {report.cleanupErrors.push(`fixture close: ${error.message}`);}
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    report.profileRemoved = Boolean(profileDir && !fs.existsSync(profileDir));
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
