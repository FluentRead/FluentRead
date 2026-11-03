#!/usr/bin/env node
/** 字幕菜单专项：生产扩展、第二屏后台 Edge、实际内容脚本；YouTube/X 页面、媒体、字幕及翻译为确定性夹具。 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {startFocusEventMonitor} = require('./mac-focus-event-monitor.cjs');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');

const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const suite = arg('suite', 'menu-ui');
assert.ok(['menu-ui', 'subtitle-stability', 'subtitle-order', 'reading-stability', 'x-reading-stability'].includes(suite), `unknown suite: ${suite}`);
const xReadingStability = suite === 'x-reading-stability';
const readingStability = suite === 'reading-stability' || xReadingStability;
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', path.join(os.tmpdir(), 'fluentread-video-menu-ui')));
const runtimeRoot = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
const helperPath = path.resolve(arg('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs')));
const diagnosticsPath = path.resolve(arg('runtime-diagnostics', path.join(path.dirname(helperPath), 'runtime-diagnostics.cjs')));
const fixtureUrl = xReadingStability ? 'https://x.com/fluentread/status/424242' : 'https://www.youtube.com/watch?v=fluentread-menu-ui';
const trackUrl = 'https://www.youtube.com/api/timedtext?v=fluentread-menu-ui&lang=en';
const firstSource = readingStability ? '국립 한국어 같이 읽는' : suite === 'subtitle-stability'
  ? 'When the subtitle settings menu opens, the bilingual subtitles should keep their original position and wrapping instead of moving sideways to make room for the toolbar.'
  : 'Reading annotations help you follow along.';
const firstTranslation = suite === 'subtitle-stability'
  ? '打开字幕设置菜单时，原文和译文应该保持原来的位置、字号及换行，不应为了给工具栏让出位置而向左移动；这是一条用于验证字幕布局稳定性的较长示例。'
  : '读音标注帮助你跟读。';
const cues = [
  {tStartMs: 0, dDurationMs: 1600, segs: [{utf8: firstSource}]},
  {tStartMs: 2000, dDurationMs: 1800, segs: [{utf8: 'Subtitle downloads stay available in the menu.'}]},
];
const timedtext = JSON.stringify({events: cues});
const playerResponse = readingStability ? {} : {captions: {playerCaptionsTracklistRenderer: {captionTracks: [{baseUrl: trackUrl, languageCode: 'en', name: {simpleText: 'English'}}]}}};
const youtubeHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FluentRead subtitle menu</title><script>var ytInitialPlayerResponse=${JSON.stringify(playerResponse)};</script></head>
<body style="margin:0;background:#eef1f5"><div id="movie_player" class="html5-video-player" style="position:relative;width:960px;height:540px;margin:24px;background:linear-gradient(130deg,#17333d,#0d1721);color:white">
<p style="position:absolute;left:28px;top:18px;font:16px system-ui">FluentRead · Subtitle menu</p><video class="html5-main-video" muted style="position:absolute;inset:0;width:100%;height:100%;opacity:0"></video>
<div id="ytp-caption-window-container" style="position:absolute;bottom:90px;left:5%;width:90%;text-align:center;font:26px system-ui"><span class="ytp-caption-segment">${firstSource}</span></div>
<div class="ytp-right-controls" style="position:absolute;bottom:14px;right:20px;width:300px;height:40px"></div></div></body></html>`;
const xHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
.fixture-controls{position:absolute;bottom:0;left:12px;right:12px;display:flex;align-items:center;height:44px;background:#222;color:#fff}
.fixture-controls button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;padding:0;border:0;background:transparent;color:#fff}
.fixture-time{flex:1}.fixture-actions{display:flex;align-items:center;flex:none}</style></head><body style="margin:24px;background:#f3f5f9">
<article><div data-testid="videoPlayer" style="position:relative;width:960px;height:540px;overflow:hidden"><video src="https://video.twimg.com/ext_tw_video/424242/pu/fixture.mp4" style="width:100%;height:100%" muted></video>
<div class="fixture-controls"><button aria-label="Play">▶</button><span class="fixture-time">0:02 / 0:30</span><div class="fixture-actions"><button aria-label="Captions">▣</button><button aria-label="Volume">◖</button><button aria-label="Settings">⚙</button><button aria-label="Picture in picture">▣</button><button aria-label="Full screen">⛶</button></div></div></div></article></body></html>`;
const html = xReadingStability ? xHtml : youtubeHtml;
const readingPhases = [
  ['latin-1', 'This line needs no annotation.', '', 3], ['korean-1', '안녕하세요', 'annyeonghaseyo', 6],
  ['empty', '', '', 9], ['korean-2', firstSource, 'gungnip hangugeo gachi ingneun', 12],
  ['latin-2', 'Another line needs no annotation.', '', 15], ['korean-3', '안녕하세요', 'annyeonghaseyo', 18],
];

let sequence = 0;
async function readConfig(page) {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!response?.success) throw Error(response?.error || 'config read failed');
    return typeof response.value === 'string' ? JSON.parse(response.value) : response.value || {};
  });
}
async function persist(page, patch) {
  const current = await readConfig(page);
  const response = await page.evaluate(({current, patch, sequence}) => chrome.runtime.sendMessage({
    type: 'persistConfig', config: {...current, ...patch}, clientId: 'video-menu-ui-fixture', sequence,
    baseRevision: current.__fluentConfigRevision,
  }), {current, patch, sequence: ++sequence});
  assert.equal(response?.success, true, JSON.stringify(response));
}
async function waitConfig(page, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const config = await readConfig(page);
    if (config.videoSubtitleAppearance?.readingAnnotation === expected) return config;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`reading preference not persisted: ${expected}`);
}
async function waitDisplayMode(page, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const config = await readConfig(page);
    if (config.videoSubtitleDisplayMode === expected) return config;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`subtitle display mode not persisted: ${expected}`);
}
async function visible(locator, value = true) {
  await locator.waitFor({state: value ? 'visible' : 'hidden', timeout: 5000});
  assert.equal(await locator.isVisible(), value);
}

/** 用真实读音处理交替经历有读音、无需读音和空字幕，记录菜单每帧几何。 */
async function runReadingStability({page, entry, diagnostics, result, checkFocus}) {
  diagnostics.setPhase('reading-stability');
  const menu = page.locator('#fluent-read-video-subtitle-menu');
  const caption = page.locator('.ytp-caption-segment');
  await page.waitForFunction(() => document.querySelector('#fluent-read-video-subtitle-reading')?.textContent === 'gungnip hangugeo gachi ingneun', null, {timeout: 30000});
  await entry.click();
  await visible(menu);
  assert.equal(await menu.locator('[data-action="toggle-reading-annotation"]').getAttribute('aria-checked'), 'true');
  const readGeometry = () => page.evaluate(() => {
    const elements = ['#fluent-read-video-subtitle-menu', '.fluent-read-video-menu-mode-group', '.fluent-read-video-menu-order-setting'];
    return elements.map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return {selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    });
  });
  const baseline = await readGeometry();
  await page.evaluate(() => {
    const selectors = ['#fluent-read-video-subtitle-menu', '.fluent-read-video-menu-mode-group', '.fluent-read-video-menu-order-setting'];
    window.__readingStabilitySamples = [];
    window.__readingStabilityTimer = setInterval(() => {
      window.__readingStabilitySamples.push(selectors.map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height};
      }));
    }, 20);
  });
  const phaseResults = [];
  for (const [phase, source, reading, seconds] of readingPhases) {
    checkFocus();
    diagnostics.setPhase(`reading-stability-${phase}`);
    if (xReadingStability) {
      await page.locator('video').evaluate((video, time) => {video.currentTime = time;}, seconds);
      await page.waitForFunction(expected => (document.querySelector('#fluent-read-video-subtitle-original')?.textContent || '') === expected, source, {timeout: 30000});
    } else await caption.evaluate((element, text) => {element.textContent = text;}, source);
    await page.waitForFunction(expected => (document.querySelector('#fluent-read-video-subtitle-reading')?.textContent || '') === expected, reading, {timeout: 30000});
    await page.waitForTimeout(180);
    phaseResults.push({phase, statusVisible: await menu.locator('[data-reading-status]').isVisible(),
      retryVisible: await menu.locator('[data-action="retry-reading-annotation"]').isVisible(), geometry: await readGeometry()});
  }
  const samples = await page.evaluate(() => {clearInterval(window.__readingStabilityTimer); return window.__readingStabilitySamples;});
  assert.ok(samples.length > 20, `Too few geometry samples: ${samples.length}`);
  const changes = samples.flatMap((sample, sampleIndex) => sample.flatMap((item, index) => ['x', 'y', 'width', 'height']
    .filter(field => Math.abs(item[field] - baseline[index][field]) > 1)
    .map(field => ({sampleIndex, selector: item.selector, field, before: baseline[index][field], after: item[field]}))));
  result.readingStability = {baseline, samples: samples.length, changes, phases: phaseResults, tolerancePx: 1};
  fs.writeFileSync(path.join(artifactsDir, 'reading-stability-geometry.json'), JSON.stringify({baseline, samples, changes, phases: phaseResults}, null, 2));
  await menu.screenshot({path: path.join(artifactsDir, 'reading-stability.png')});
  result.screenshots.push('reading-stability.png');
  assert.ok(phaseResults.every(phase => !phase.statusVisible && !phase.retryVisible), `Routine reading states must stay quiet: ${JSON.stringify(phaseResults)}`);
  assert.deepEqual(changes, [], 'Reading state changes must not move or resize the menu');
  result.cases.push({name: 'reading-status-transitions-keep-menu-geometry-stable', passed: true, samples: samples.length});
}

/** 只以真实生产内容脚本的布局结果判定，不在夹具中模拟字幕定位或触发应用事件。 */
async function runSubtitleStability({page, entry, diagnostics, result, checkFocus}) {
  const menu = page.locator('#fluent-read-video-subtitle-menu');
  const toggle = menu.locator('[data-action="toggle-reading-annotation"]');
  const disclosure = menu.locator('[data-action="toggle-subtitle-downloads"]');
  const help = menu.locator('[data-reading-help]');
  await page.waitForFunction(({source, translation}) =>
    document.querySelector('#fluent-read-video-subtitle-original')?.textContent === source
    && document.querySelector('#fluent-read-video-subtitle')?.textContent === translation,
  {source: firstSource, translation: firstTranslation}, {timeout: 15000});
  const geometry = [];
  const capture = async (scenario, phase) => {
    checkFocus();
    diagnostics.setPhase(`${scenario}-${phase}`);
    await page.waitForTimeout(250);
    const metrics = await page.evaluate(() => {
      const round = value => Math.round(value * 1000) / 1000;
      const measure = selector => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
        return {rect: {x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height)},
          fontSize: css.fontSize, lineHeight: css.lineHeight, textAlign: css.textAlign, left: css.left, top: css.top,
          bottom: css.bottom, maxWidth: css.maxWidth, transform: css.transform, parent: el.parentElement?.id,
          display: css.display, visibility: css.visibility, text: el.textContent};
      };
      const menu = document.querySelector('#fluent-read-video-subtitle-menu');
      return {player: measure('#movie_player'), panel: measure('#fluent-read-video-subtitle-panel'),
        original: measure('#fluent-read-video-subtitle-original'), translated: measure('#fluent-read-video-subtitle'),
        layer: measure('#fluent-read-video-subtitle-layer'), menu: menu && !menu.hidden ? measure('#fluent-read-video-subtitle-menu') : null,
        viewport: {width: innerWidth, height: innerHeight}};
    });
    assert.equal(metrics.original?.text, firstSource);
    assert.equal(metrics.translated?.text, firstTranslation);
    const filename = `${scenario}-${phase}.png`;
    await page.screenshot({path: path.join(artifactsDir, filename)});
    result.screenshots.push(filename);
    geometry.push({scenario, phase, ...metrics});
    fs.writeFileSync(path.join(artifactsDir, 'subtitle-geometry.json'), `${JSON.stringify(geometry, null, 2)}\n`);
    checkFocus();
    return metrics;
  };
  const compare = (before, after) => {
    const changes = [];
    for (const name of ['panel', 'original', 'translated']) {
      for (const field of ['x', 'y', 'width', 'height']) {
        const delta = after[name].rect[field] - before[name].rect[field];
        if (Math.abs(delta) > 1) changes.push({surface: name, field, before: before[name].rect[field], after: after[name].rect[field], delta: Math.round(delta * 1000) / 1000});
      }
      for (const field of ['fontSize', 'lineHeight', 'textAlign']) {
        if (before[name][field] !== after[name][field]) changes.push({surface: name, field, before: before[name][field], after: after[name][field]});
      }
    }
    return changes;
  };
  const failures = [];
  const scenarios = [
    {name: 'desktop-960', viewport: {width: 1280, height: 900}, width: 960, height: 540, complete: true},
    {name: 'large-1232', viewport: {width: 1280, height: 900}, width: 1232, height: 720},
    {name: 'narrow-320', viewport: {width: 320, height: 844}, width: 288, height: 480},
  ];
  for (const scenario of scenarios) {
    await page.setViewportSize(scenario.viewport);
    await page.locator('#movie_player').evaluate((el, size) => {
      el.style.width = `${size.width}px`; el.style.height = `${size.height}px`; el.style.margin = size.width < 400 ? '16px' : '24px';
    }, scenario);
    const baseline = await capture(scenario.name, 'before-open');
    await entry.click();
    await capture(scenario.name, 'menu-open');
    if (scenario.complete) {
      await disclosure.click();
      await capture(scenario.name, 'downloads-open');
      await disclosure.click();
      await capture(scenario.name, 'downloads-closed');
      await toggle.hover();
      await visible(help);
      await capture(scenario.name, 'reading-help-hover');
      await page.mouse.move(4, 4);
      await menu.locator('[data-mode="bilingual"]').focus();
      await toggle.focus();
      await visible(help);
      await capture(scenario.name, 'reading-help-focus');
      await page.keyboard.press('Escape');
    }
    await menu.locator('[data-action="close-menu"]').click();
    await capture(scenario.name, 'menu-closed');
    await entry.click();
    await capture(scenario.name, 'menu-reopened');
    await menu.locator('[data-action="close-menu"]').click();
    await capture(scenario.name, 'menu-closed-again');
    const transitions = geometry.filter(item => item.scenario === scenario.name && item.phase !== 'before-open')
      .map(item => ({phase: item.phase, changes: compare(baseline, item)}));
    const failedTransitions = transitions.filter(item => item.changes.length);
    const record = {name: `${scenario.name}-bilingual-subtitle-geometry-stable`, passed: failedTransitions.length === 0, transitions};
    result.cases.push(record);
    if (failedTransitions.length) failures.push({scenario: scenario.name, transitions: failedTransitions});
  }
  result.subtitleGeometry = geometry;
  result.geometryFailures = failures;
  result.geometryTolerancePx = 1;
  fs.writeFileSync(path.join(artifactsDir, 'subtitle-dom.html'), await page.content());
}

/** 双语顺序通过真实菜单输入切换，既检查排版也检查保存、节点复用及请求数。 */
async function runSubtitleOrder({page, entry, control, background, mediaSrc, diagnostics, result, checkFocus}) {
  const menu = page.locator('#fluent-read-video-subtitle-menu');
  const source = page.locator('#fluent-read-video-subtitle-original');
  const translated = page.locator('#fluent-read-video-subtitle');
  const orderButton = order => menu.locator(`[data-subtitle-order="${order}"]`);
  const waitCaption = () => page.waitForFunction(({source, translation}) =>
    document.querySelector('#fluent-read-video-subtitle-original')?.textContent === source
    && document.querySelector('#fluent-read-video-subtitle')?.textContent === translation,
  {source: firstSource, translation: firstTranslation}, {timeout: 15000});
  const waitOrderConfig = async expected => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const config = await readConfig(control);
      if (config.videoSubtitleAppearance?.bilingualOrder === expected) return config;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`subtitle order not persisted: ${expected}`);
  };
  const geometry = [];
  const assertOrder = async (order, phase) => {
    checkFocus();
    diagnostics.setPhase(phase);
    await page.waitForFunction(expected => {
      const original = document.querySelector('#fluent-read-video-subtitle-original');
      const translation = document.querySelector('#fluent-read-video-subtitle');
      if (!original || !translation) return false;
      const a = original.getBoundingClientRect(), b = translation.getBoundingClientRect();
      return a.height > 0 && b.height > 0 && (expected === 'original-first' ? a.bottom <= b.top + 1 : b.bottom <= a.top + 1);
    }, order, {timeout: 15000});
    for (const candidate of ['original-first', 'translation-first']) {
      assert.equal(await orderButton(candidate).getAttribute('aria-checked'), String(candidate === order));
    }
    const metrics = await page.evaluate(() => {
      const measure = id => {
        const node = document.getElementById(id), rect = node.getBoundingClientRect();
        return {top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
          order: getComputedStyle(node).order, text: node.textContent};
      };
      const menu = document.getElementById('fluent-read-video-subtitle-menu');
      const box = menu.getBoundingClientRect();
      return {original: measure('fluent-read-video-subtitle-original'), translated: measure('fluent-read-video-subtitle'),
        menu: {x: box.x, right: box.right, y: box.y, width: box.width, scrollWidth: menu.scrollWidth, clientWidth: menu.clientWidth},
        viewport: {width: innerWidth, height: innerHeight}};
    });
    assert.equal(metrics.original.text, firstSource);
    assert.equal(metrics.translated.text, firstTranslation);
    geometry.push({phase, order, ...metrics});
    fs.writeFileSync(path.join(artifactsDir, 'subtitle-order-geometry.json'), `${JSON.stringify(geometry, null, 2)}\n`);
    return metrics;
  };
  const shoot = async name => {
    checkFocus();
    const file = `${name}.png`;
    await page.screenshot({path: path.join(artifactsDir, file)});
    result.screenshots.push(file);
  };
  await waitCaption();
  await entry.click();
  await visible(menu);
  await assertOrder('original-first', 'order-default');
  const originalNode = await source.elementHandle(), translationNode = await translated.elementHandle();
  await page.waitForTimeout(500);
  const before = await background.evaluate(() => globalThis.__videoMenuUiTranslations);
  for (const order of ['translation-first', 'original-first', 'translation-first', 'original-first']) {
    await orderButton(order).click();
    await waitOrderConfig(order);
    await assertOrder(order, `order-repeat-${geometry.length}`);
    assert.equal(await originalNode.evaluate(node => node === document.querySelector('#fluent-read-video-subtitle-original')), true);
    assert.equal(await translationNode.evaluate(node => node === document.querySelector('#fluent-read-video-subtitle')), true);
  }
  // 菜单方向键只移动本组选项焦点；Space 提交当前选项，不触发播放器暂停。
  await orderButton('original-first').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await orderButton('translation-first').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Space');
  await waitOrderConfig('translation-first');
  await assertOrder('translation-first', 'order-keyboard');
  await shoot('subtitle-order-translation-first-desktop');
  await page.waitForTimeout(300);
  const after = await background.evaluate(() => globalThis.__videoMenuUiTranslations);
  assert.equal(after, before, 'Changing subtitle order must reuse completed translations');
  result.cases.push({name: 'repeat-order-switch-keeps-nodes-and-cached-translation', passed: true, before, after, keyboard: 'ArrowRight + Space'});
  const orderHint = menu.locator('[data-subtitle-order-hint]');
  await visible(orderHint, false);
  for (const mode of ['translation-only', 'original-only']) {
    await menu.locator(`[data-mode="${mode}"]`).click();
    if (mode === 'translation-only') {await visible(translated); await visible(source, false);}
    else {
      await visible(translated, false);
      // 桌面仅原文可以恢复网站字幕；窄屏与读音模式则使用归一化原文。
      await page.waitForFunction(() => ['#fluent-read-video-subtitle-original', '.ytp-caption-segment'].some(selector => {
        const node = document.querySelector(selector);
        if (!node?.textContent) return false;
        const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
      }));
    }
    assert.equal((await readConfig(control)).videoSubtitleAppearance.bilingualOrder, 'translation-first');
    for (const order of ['original-first', 'translation-first']) assert.equal(await orderButton(order).isDisabled(), true);
    await visible(orderHint);
    assert.match(await orderHint.textContent(), /仅双语.*保留/);
    assert.equal(await orderButton('translation-first').getAttribute('aria-checked'), 'true');
    result.cases.push({name: `${mode}-disables-inactive-order-and-preserves-preference`, passed: true});
  }
  await menu.locator('[data-mode="bilingual"]').click();
  await waitCaption();
  await assertOrder('translation-first', 'order-back-to-bilingual');
  for (const order of ['original-first', 'translation-first']) assert.equal(await orderButton(order).isDisabled(), false);
  await visible(orderHint, false);
  await page.waitForTimeout(300);
  const restoredRequests = await background.evaluate(() => globalThis.__videoMenuUiTranslations);
  assert.equal(restoredRequests, after, 'Returning to bilingual must restore the saved order and reuse completed translations');
  result.cases.push({name: 'return-to-bilingual-restores-enabled-order-without-new-requests', passed: true, before: after, after: restoredRequests});
  for (const width of [390, 320]) {
    await menu.locator('[data-action="close-menu"]').click();
    await page.setViewportSize({width, height: 844});
    await page.locator('#movie_player').evaluate((player, width) => {
      player.style.width = `${width - 32}px`; player.style.height = '480px'; player.style.margin = '16px';
    }, width);
    await entry.click();
    for (const order of ['original-first', 'translation-first']) {
      await orderButton(order).click();
      await waitOrderConfig(order);
      const metrics = await assertOrder(order, `order-narrow-${width}-${order}`);
      assert.ok(metrics.menu.x >= -1 && metrics.menu.right <= width + 1 && metrics.menu.y >= -1, JSON.stringify(metrics));
      assert.ok(metrics.menu.scrollWidth <= metrics.menu.clientWidth + 1, JSON.stringify(metrics));
      const buttons = await menu.locator('[data-subtitle-order]').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(); return {left: rect.left, right: rect.right, width: rect.width, height: rect.height};
      }));
      assert.ok(buttons.every(button => button.left >= 0 && button.right <= width + 1 && button.width > 30 && button.height >= 24), JSON.stringify(buttons));
      await shoot(`subtitle-order-${width}-${order}`);
    }
    result.cases.push({name: `narrow-${width}-order-controls-fit-and-work`, passed: true});
  }
  diagnostics.setPhase('order-reload');
  await page.reload();
  await page.locator('#movie_player').evaluate(player => {player.style.width = '288px'; player.style.height = '480px'; player.style.margin = '16px';});
  await page.locator('video').evaluate((video, src) => {video.src = src; video.load();}, mediaSrc);
  await entry.waitFor({timeout: 15000});
  await waitCaption();
  await entry.click();
  await assertOrder('translation-first', 'order-persisted-after-reload');
  result.cases.push({name: 'saved-subtitle-order-survives-page-reload', passed: true});
  const saved = await readConfig(control);
  await persist(control, {videoSubtitleAppearance: {...saved.videoSubtitleAppearance, bilingualOrder: 'original-first'}});
  await assertOrder('original-first', 'order-external-config-sync');
  await shoot('subtitle-order-external-config-sync');
  result.cases.push({name: 'external-config-order-syncs-without-reopening-menu', passed: true});
  result.subtitleOrderGeometry = geometry;
  fs.writeFileSync(path.join(artifactsDir, 'subtitle-order-dom.html'), await page.content());
}

async function main() {
  if (!runtimeRoot) throw Error('--playwright-root required');
  assert.ok(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'build not found');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const {chromium} = createRequire(path.join(path.resolve(runtimeRoot), '__video_menu_ui.cjs'))('playwright');
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  const {createRuntimeDiagnostics, finalizeRun} = require(diagnosticsPath);
  const diagnostics = createRuntimeDiagnostics();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-video-menu-ui-'));
  const result = {ok: false, suite, sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim(), extensionDir, artifactsDir, cases: [], screenshots: [], unexpectedNetwork: [],
    buildContentSha256: createHash('sha256').update(fs.readFileSync(path.join(extensionDir, 'content-scripts/content.js'))).digest('hex'),
    scope: `Production Edge content-script UI with deterministic ${xReadingStability ? 'X and cached AI subtitles' : 'YouTube'}, media, subtitle and Microsoft fixtures; no live provider, real website, Firefox or assistive-technology speech acceptance`,
    notRun: ['physical Firefox', 'live service quality', 'all reading engines', 'native mobile device'],
  };
  let session, page, primaryError, background, browserClosed = false, launchStarted = false, focusMonitor, browserPid, focusError;
  const checkFocus = () => {
    if (focusError || focusMonitor?.error) throw focusError || focusMonitor.error;
    assert.ok(!browserPid || !focusMonitor.events.some(event => event.pid === browserPid), 'owned Edge became foreground');
  };
  try {
    result.buildFreshness = assertFreshProductionExtension(extensionDir, path.resolve(__dirname, '../..'));
    const mediaPath = path.join(artifactsDir, 'fixture.mp4');
    const mediaSize = suite === 'subtitle-stability' ? '320x180' : '16x16';
    const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${mediaSize}:r=1`, '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaPath], {encoding: 'utf8', timeout: 30000});
    assert.equal(media.status, 0, media.stderr);
    focusMonitor = startFocusEventMonitor({onEvent: event => {
      if (browserPid && event.pid === browserPid) focusError = Error('Owned Edge became foreground during UI verification');
    }, onError: error => {focusError = error;}});
    result.focusObserver = await focusMonitor.ready;
    launchStarted = true;
    session = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      headless: false, background: true, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
    });
    // 启动 helper 拥有本次临时 profile 和浏览器；不接触其他浏览器进程。
    result.cleanupPolicy = 'focus-safe-helper-exact-profile-and-captured-browser-pid';
    const context = session.context;
    const processSession = await context.browser().newBrowserCDPSession();
    try {
      const {processInfo} = await processSession.send('SystemInfo.getProcessInfo');
      browserPid = processInfo.find(process => process.type === 'browser')?.id;
      assert.ok(Number.isSafeInteger(browserPid) && browserPid > 0, 'owned browser PID unavailable');
    } finally {await processSession.detach();}
    checkFocus();
    Object.assign(result, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    await diagnostics.start(context);
    background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const extensionId = new URL(background.url()).host;
    diagnostics.setExtensionId(extensionId);
    await diagnostics.flush();
    await background.evaluate(({trackUrl, timedtext, firstTranslation}) => {
      const nativeFetch = fetch.bind(globalThis);
      globalThis.__videoMenuUiUnexpectedNetwork = [];
      globalThis.__videoMenuUiTranslations = 0;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext') return Promise.resolve(new Response(timedtext, {headers: {'content-type': 'application/json'}}));
        if (url.hostname === 'edge.microsoft.com' && url.pathname === '/translate/translatetext') {
          globalThis.__videoMenuUiTranslations++;
          const sources = JSON.parse(init.body);
          return Promise.resolve(new Response(JSON.stringify(sources.map(source => ({translations: [{text: source.includes('downloads') ? '字幕下载仍可在菜单中使用。' : firstTranslation}]}))), {headers: {'content-type': 'application/json'}}));
        }
        if (['http:', 'https:'].includes(url.protocol)) {
          globalThis.__videoMenuUiUnexpectedNetwork.push(url.href);
          return Promise.resolve(new Response(null, {status: 204}));
        }
        return nativeFetch(input, init);
      };
    }, {trackUrl, timedtext, firstTranslation});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.href === fixtureUrl) return route.fulfill({contentType: 'text/html', body: html});
      if (xReadingStability && url.hostname === 'video.twimg.com') {
        const bytes = fs.readFileSync(mediaPath), match = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        if (!match) return route.fulfill({contentType: 'video/mp4', headers: {'accept-ranges': 'bytes'}, body: bytes});
        const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        return route.fulfill({status: 206, contentType: 'video/mp4', headers: {'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`}, body: bytes.subarray(start, end + 1)});
      }
      if (xReadingStability && url.hostname === 'x.com' && url.pathname === '/favicon.ico') return route.fulfill({status: 204, body: ''});
      if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico') return route.fulfill({status: 204, body: ''});
      if (url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext') return route.fulfill({contentType: 'application/json', body: timedtext});
      if (['http:', 'https:'].includes(url.protocol)) {
        result.unexpectedNetwork.push(url.href);
        return route.fulfill({status: 204, body: ''});
      }
      return route.continue();
    });
    const control = await newPageWithoutForeground(context);
    await diagnostics.attachPage(control, 'config-control-popup');
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    await control.locator('.popup-shell[data-config-ready="true"]').waitFor({timeout: 15000});
    const initial = await readConfig(control);
    await persist(control, {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, theme: 'dark', from: readingStability ? 'ko' : 'en', to: 'zh-Hans',
      videoTranslationEnabled: true, videoService: 'microsoft', videoServiceDefaultMigrated: true, videoSubtitleVisible: true,
      videoSubtitleDisplayMode: suite === 'reading-stability' ? 'original-only' : 'bilingual', videoSubtitleAppearance: {...initial.videoSubtitleAppearance, readingAnnotation: readingStability},
      ...(xReadingStability ? {videoLocalModel: 'tiny', videoSourceLanguage: 'ko'} : {}), useCache: false});
    if (xReadingStability) {
      const cachedCues = [{startMs: 0, durationMs: 2000, text: firstSource}, ...readingPhases.filter(([, source]) => source)
        .map(([, text, , seconds]) => ({startMs: seconds * 1000, durationMs: 2000, text}))];
      const cached = await control.evaluate(cues => chrome.runtime.sendMessage({type: 'fluentReadSetVideoAiSubtitleCache',
        source: {mediaId: '424242'}, model: 'tiny', sourceLanguage: 'ko', cues}), cachedCues);
      assert.equal(cached?.cached, true, 'Seeded AI subtitle cache is required');
    }
    page = await newPageWithoutForeground(context);
    await diagnostics.attachPage(page, xReadingStability ? 'x-menu-content-script' : 'youtube-menu-content-script');
    await page.setViewportSize({width: 1280, height: 900});
    diagnostics.setPhase('menu-initial');
    await page.goto(fixtureUrl);
    await activateExtensionTabWithoutForeground(context, page);
    if (!xReadingStability) await page.locator('video').evaluate((video, src) => {video.src = src; video.load();}, `data:video/mp4;base64,${fs.readFileSync(mediaPath).toString('base64')}`);
    const entry = page.locator('#fluent-read-video-subtitle-button');
    await entry.waitFor({timeout: 15000});
    if (readingStability) {
      await runReadingStability({page, entry, diagnostics, result, checkFocus});
    } else if (suite === 'subtitle-stability') {
      await runSubtitleStability({page, entry, diagnostics, result, checkFocus});
    } else if (suite === 'subtitle-order') {
      await runSubtitleOrder({page, entry, control, background, mediaSrc: `data:video/mp4;base64,${fs.readFileSync(mediaPath).toString('base64')}`, diagnostics, result, checkFocus});
    } else {
    await entry.click();
    const menu = page.locator('#fluent-read-video-subtitle-menu');
    const toggle = menu.locator('[data-action="toggle-reading-annotation"]');
    const helpButton = toggle;
    const help = menu.locator('[data-reading-help]');
    const disclosure = menu.locator('[data-action="toggle-subtitle-downloads"]');
    const downloads = menu.locator('[data-subtitle-downloads]');
    const header = menu.locator('.fluent-read-video-menu-title');
    const headerGeometry = async () => header.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return {width: rect.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        controls: [...el.querySelectorAll('button')].filter(button => !button.closest('[hidden]')).map(button => {
          const box = button.getBoundingClientRect();
          return {action: button.dataset.action, left: box.left - rect.left, right: box.right - rect.left, top: box.top - rect.top, bottom: box.bottom - rect.top};
        })};
    });
    const assertHeaderFits = geometry => {
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, JSON.stringify(geometry));
      assert.ok(geometry.controls.every(control => control.left >= -1 && control.right <= geometry.width + 1), JSON.stringify(geometry));
    };
    const shoot = async name => {
      checkFocus();
      const filename = `${name}.png`;
      if (await help.isVisible()) {
        // Native top-layer popovers may extend beyond the menu border box.
        const boxes = [await menu.boundingBox(), await help.boundingBox()].filter(Boolean);
        const viewport = page.viewportSize() || await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
        const left = Math.max(0, Math.min(...boxes.map(box => box.x)) - 8);
        const top = Math.max(0, Math.min(...boxes.map(box => box.y)) - 8);
        const right = Math.min(viewport.width, Math.max(...boxes.map(box => box.x + box.width)) + 8);
        const bottom = Math.min(viewport.height, Math.max(...boxes.map(box => box.y + box.height)) + 8);
        await page.screenshot({path: path.join(artifactsDir, filename), clip: {x: left, y: top, width: right - left, height: bottom - top}});
      } else await menu.screenshot({path: path.join(artifactsDir, filename)});
      result.screenshots.push(filename);
      checkFocus();
    };
    const readReadingAppearance = () => toggle.evaluate(el => {
      const css = getComputedStyle(el), indicator = getComputedStyle(el, '::after');
      return {background: css.backgroundColor, color: css.color, borderColor: css.borderColor, borderWidth: css.borderWidth,
        boxShadow: css.boxShadow, transform: css.transform, outlineColor: css.outlineColor, outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth,
        checked: el.getAttribute('aria-checked'), hovered: el.matches(':hover'), focusVisible: el.matches(':focus-visible'),
        indicator: {content: indicator.content, width: indicator.width, height: indicator.height, background: indicator.backgroundColor, opacity: indicator.opacity}};
    });
    const visualFeedback = appearance => ({background: appearance.background, color: appearance.color,
      borderColor: appearance.borderColor, boxShadow: appearance.boxShadow, transform: appearance.transform});
    const configFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const assertFocusRing = appearance => {
      assert.equal(appearance.focusVisible, true);
      assert.equal(appearance.outlineStyle, 'solid');
      assert.ok(parseFloat(appearance.outlineWidth) >= 2, `Keyboard focus needs a visible outline: ${JSON.stringify(appearance)}`);
      assert.equal(appearance.outlineColor, 'rgb(255, 173, 194)');
    };
    const rgba = color => {
      const values = color.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/,\s*/).map(Number);
      assert.ok(values?.length >= 3, `Expected computed RGB color: ${color}`);
      return [...values.slice(0, 3), values.length > 3 ? values[3] : 1];
    };
    const assertSoftBrand = appearance => {
      const [red, green, blue, alpha] = rgba(appearance.background);
      assert.ok(alpha >= .2 && alpha <= .28 && red > green * 1.5 && red > blue,
        `Selected reading icon needs the menu's translucent brand treatment: ${appearance.background}`);
      assert.equal(appearance.color, 'rgb(255, 173, 194)');
      assert.equal(appearance.borderColor, 'rgba(239, 71, 118, 0.32)');
      assert.ok(['none', 'normal'].includes(appearance.indicator.content), 'Reading icon must not add an extra state badge');
    };
    const readReferenceAppearance = locator => locator.evaluate(el => {
      const css = getComputedStyle(el);
      return {background: css.backgroundColor, color: css.color, borderColor: css.borderColor, boxShadow: css.boxShadow};
    });
    const readCaptionGeometry = () => page.evaluate(() => Object.fromEntries(['fluent-read-video-subtitle-panel', 'fluent-read-video-subtitle-original', 'fluent-read-video-subtitle'].map(id => {
      const el = document.getElementById(id), rect = el.getBoundingClientRect(), css = getComputedStyle(el);
      return [id, {x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: css.fontSize, lineHeight: css.lineHeight, text: el.textContent}];
    })));
    await page.waitForFunction(({source, translation}) => document.querySelector('#fluent-read-video-subtitle-original')?.textContent === source
      && document.querySelector('#fluent-read-video-subtitle')?.textContent === translation, {source: firstSource, translation: firstTranslation});
    const captionBeforeFeedback = await readCaptionGeometry();
    const assertCaptionStable = async phase => {
      assert.deepEqual(await readCaptionGeometry(), captionBeforeFeedback, `Reading feedback must not move subtitles: ${phase}`);
    };
    await visible(menu);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await toggle.getAttribute('aria-label') || (await toggle.textContent()).trim(), '读音标注');
    const iconShape = await toggle.locator('svg').evaluate(el => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      return {width: r.width, height: r.height, color: css.color};
    });
    assert.ok(iconShape.width >= 14 && iconShape.height >= 14, JSON.stringify(iconShape));
    const offAppearance = await readReadingAppearance();
    const selectedModeAppearance = await readReferenceAppearance(menu.locator('[data-mode][aria-checked="true"]'));
    const downloadIdleAppearance = await readReferenceAppearance(disclosure);
    assert.equal(offAppearance.checked, 'false');
    assert.equal(offAppearance.background, 'rgba(0, 0, 0, 0)');
    assert.equal(offAppearance.background, downloadIdleAppearance.background, 'Off reading icon must share the neighboring header icon transparent background');
    assert.equal(offAppearance.color, downloadIdleAppearance.color);
    assert.ok(['none', 'normal'].includes(offAppearance.indicator.content), 'Off reading icon must not show the enabled indicator');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(el => Boolean(el.closest('.fluent-read-video-menu-title'))), true);
    assert.equal(await disclosure.evaluate(el => Boolean(el.closest('.fluent-read-video-menu-title'))), true);
    assert.equal(await toggle.evaluate(el => Boolean(el.closest('[data-timing-row], .fluent-read-video-menu-playback-controls'))), false);
    assert.equal(await menu.locator('.fluent-read-video-menu-body [data-action="toggle-subtitle-downloads"]').count(), 0);
    await visible(downloads, false);
    await visible(help, false);
    await page.evaluate(() => {window.__videoMenuUiToggle = document.querySelector('[data-action="toggle-reading-annotation"]');});
    const initialBounds = await menu.boundingBox();
    const desktopHeader = await headerGeometry();
    assertHeaderFits(desktopHeader);
    result.cases.push({name: 'bilingual-default-reading-and-download-icons-in-header', passed: true, iconShape, offAppearance, initialBounds, desktopHeader});
    await shoot('menu-default-dark');
    await shoot('reading-off');

    diagnostics.setPhase('reading-help');
    await disclosure.hover();
    await page.waitForTimeout(220);
    const downloadHoverAppearance = await readReferenceAppearance(disclosure);
    result.designReferences = {selectedModeAppearance, downloadIdleAppearance, downloadHoverAppearance};
    await page.mouse.move(4, 4);
    const iconBeforeHover = await toggle.boundingBox();
    const offConfigBeforeHover = configFingerprint(await readConfig(control));
    await helpButton.hover();
    await visible(help);
    await page.waitForTimeout(220);
    const offHoverAppearance = await readReadingAppearance();
    result.readingFeedback = {offAppearance, offHoverAppearance};
    assert.notDeepEqual(visualFeedback(offHoverAppearance), visualFeedback(offAppearance), 'Off reading icon hover must provide visible feedback');
    assert.equal(offHoverAppearance.background, 'rgba(255, 255, 255, 0.07)');
    assert.equal(offHoverAppearance.color, 'rgb(245, 245, 247)');
    assert.equal(offHoverAppearance.background, downloadHoverAppearance.background, 'Off hover must match the neighboring header icon');
    assert.equal(offHoverAppearance.color, downloadHoverAppearance.color);
    assert.equal((await readConfig(control)).videoSubtitleAppearance.readingAnnotation, false);
    assert.equal(configFingerprint(await readConfig(control)), offConfigBeforeHover, 'Hover must not write any configuration');
    await assertCaptionStable('off-hover');
    const iconAfterHover = await toggle.boundingBox();
    assert.deepEqual(iconAfterHover, iconBeforeHover, 'help must not move the reading icon');
    assert.match(await help.textContent(), /拼音|罗马音/);
    assert.match(await help.textContent(), /kyō|konnichiwa|watashi/);
    await shoot('menu-reading-help');
    await shoot('reading-off-hover');
    diagnostics.setPhase('reading-help-pointer-transfer');
    const helpBounds = await help.boundingBox();
    const iconBounds = await toggle.boundingBox();
    assert.ok(helpBounds && iconBounds);
    const transferX = Math.max(helpBounds.x + 2, Math.min(iconBounds.x + iconBounds.width / 2, helpBounds.x + helpBounds.width - 2));
    const helpIsAbove = helpBounds.y + helpBounds.height <= iconBounds.y;
    const gapY = helpIsAbove ? (helpBounds.y + helpBounds.height + iconBounds.y) / 2
      : (iconBounds.y + iconBounds.height + helpBounds.y) / 2;
    await page.mouse.move(transferX, gapY);
    await page.waitForTimeout(50);
    await visible(help);
    await help.hover();
    await page.waitForTimeout(180);
    await visible(help);
    assert.equal(await help.evaluate(el => el.matches(':popover-open') && el.matches(':hover')), true);
    assert.equal(configFingerprint(await readConfig(control)), offConfigBeforeHover, 'Pointer transfer into help must not change settings');
    await assertCaptionStable('help-pointer-transfer');
    await shoot('menu-reading-help-pointer-transfer');
    result.cases.push({name: 'reading-help-stays-open-across-pointer-gap-into-popover', passed: true, helpBounds, iconBounds, gapY});
    checkFocus();
    await menu.evaluate(el => el.parentElement.appendChild(el));
    await page.mouse.move(4, 4);
    await menu.locator('[data-mode="original-only"]').focus();
    await helpButton.hover();
    await visible(help);
    assert.equal(await help.evaluate(el => el.matches(':popover-open')), true, 'native popover must reopen after host rebind moves menu DOM');
    result.cases.push({name: 'native-help-popover-reopens-after-host-menu-reparent', passed: true});
    await page.mouse.move(4, 4);
    await menu.locator('[data-mode="original-only"]').focus();
    await visible(help, false);
    await menu.locator('[data-action="open-settings"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await visible(help);
    const offKeyboardAppearance = await readReadingAppearance();
    result.readingFeedback.offKeyboardAppearance = offKeyboardAppearance;
    assertFocusRing(offKeyboardAppearance);
    assert.equal(offKeyboardAppearance.background, 'rgba(255, 255, 255, 0.07)');
    assert.equal(offKeyboardAppearance.color, 'rgb(245, 245, 247)');
    assert.equal((await readConfig(control)).videoSubtitleAppearance.readingAnnotation, false);
    assert.equal(configFingerprint(await readConfig(control)), offConfigBeforeHover, 'Keyboard focus must not write any configuration');
    await assertCaptionStable('off-keyboard-focus');
    await page.keyboard.press('Escape');
    await visible(menu);
    await visible(help, false);
    assert.equal(await helpButton.evaluate(el => el === document.activeElement), true);
    result.cases.push({name: 'reading-icon-help-hover-focus-and-escape-without-config-change', passed: true, iconBeforeHover, iconAfterHover, offHoverAppearance});

    diagnostics.setPhase('reading-persistence');
    await toggle.click();
    await waitConfig(control, true);
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.mouse.move(4, 4);
    await menu.locator('[data-mode="bilingual"]').focus();
    await menu.locator('[data-mode="bilingual"]').evaluate(el => el.blur());
    await page.waitForTimeout(220);
    const onAppearance = await readReadingAppearance();
    result.readingFeedback.onAppearance = onAppearance;
    assert.notDeepEqual(visualFeedback(onAppearance), visualFeedback(offAppearance), 'enabled reading icon must have an explicit visual state');
    await assertCaptionStable('on-idle');
    await shoot('reading-on');
    const onConfigBeforeHover = configFingerprint(await readConfig(control));
    await toggle.hover();
    await visible(help);
    await page.waitForTimeout(220);
    const onHoverAppearance = await readReadingAppearance();
    result.readingFeedback.onHoverAppearance = onHoverAppearance;
    await shoot('reading-on-hover');
    assertSoftBrand(onAppearance);
    assertSoftBrand(onHoverAppearance);
    assert.equal(onAppearance.background, 'rgba(239, 71, 118, 0.2)');
    assert.equal(onAppearance.background, selectedModeAppearance.background, 'Selected reading icon must share the selected mode tab background');
    assert.equal(onAppearance.color, selectedModeAppearance.color, 'Selected reading icon must share the selected mode tab color');
    assert.equal(onHoverAppearance.background, 'rgba(239, 71, 118, 0.28)');
    assert.equal(onHoverAppearance.color, onAppearance.color);
    assert.notDeepEqual(visualFeedback(onHoverAppearance), visualFeedback(onAppearance), 'Enabled reading icon hover must remain visually distinct from its idle state');
    assert.match(await help.textContent(), /拼音|罗马音/);
    assert.equal((await readConfig(control)).videoSubtitleAppearance.readingAnnotation, true);
    assert.equal(configFingerprint(await readConfig(control)), onConfigBeforeHover, 'Selected hover must not write any configuration');
    await assertCaptionStable('on-hover');
    await page.mouse.move(4, 4);
    await menu.locator('[data-mode="bilingual"]').focus();
    await page.waitForTimeout(220);
    const onMouseleaveAppearance = await readReadingAppearance();
    result.readingFeedback.onMouseleaveAppearance = onMouseleaveAppearance;
    assert.deepEqual(visualFeedback(onMouseleaveAppearance), visualFeedback(onAppearance), 'Mouseleave must restore the selected idle style');
    assert.equal((await readConfig(control)).videoSubtitleAppearance.readingAnnotation, true);
    assert.equal(configFingerprint(await readConfig(control)), onConfigBeforeHover, 'Mouseleave must preserve configuration');
    await assertCaptionStable('on-mouseleave');
    await menu.locator('[data-action="open-settings"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await visible(help);
    const keyboardAppearance = await readReadingAppearance();
    result.readingFeedback.keyboardAppearance = keyboardAppearance;
    assertSoftBrand(keyboardAppearance);
    assertFocusRing(keyboardAppearance);
    assert.equal(keyboardAppearance.background, onAppearance.background);
    assert.equal(configFingerprint(await readConfig(control)), onConfigBeforeHover, 'Selected keyboard focus must not write any configuration');
    await assertCaptionStable('on-keyboard-focus');
    await shoot('reading-keyboard-focus');
    result.cases.push({name: 'reading-icon-brand-hover-focus-and-mouseleave-feedback', passed: true,
      offAppearance, offHoverAppearance, onAppearance, onHoverAppearance, onMouseleaveAppearance, keyboardAppearance,
      subtitleGeometryUnchanged: true});
    assert.equal(await page.evaluate(() => window.__videoMenuUiToggle === document.querySelector('[data-action="toggle-reading-annotation"]')), true);
    await menu.locator('[data-action="close-menu"]').click();
    await visible(menu, false);
    await visible(help, false);
    await entry.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await menu.locator('[data-mode="translation-only"]').click();
    await page.waitForFunction(() => document.querySelector('[data-reading-status]')?.textContent?.includes('原文'));
    const translationOnlyConfig = await waitDisplayMode(control, 'translation-only');
    assert.equal(translationOnlyConfig.videoSubtitleAppearance.readingAnnotation, true);
    assert.equal(translationOnlyConfig.videoSubtitleDisplayMode, 'translation-only', 'Reading preference must not automatically switch the display mode');
    const showOriginal = menu.locator('[data-reading-bilingual]');
    await visible(showOriginal);
    assert.equal(await showOriginal.isDisabled(), false);
    assert.equal(await showOriginal.getAttribute('role'), 'menuitem');
    assert.equal(await showOriginal.getAttribute('aria-checked'), null);
    await shoot('menu-reading-original-required');
    await showOriginal.click();
    await page.waitForFunction(() => document.querySelector('.fluent-read-video-menu-mode-group [data-mode="bilingual"]')?.getAttribute('aria-checked') === 'true'
      && document.querySelector('[data-reading-bilingual]')?.hidden === true);
    const bilingualConfig = await waitDisplayMode(control, 'bilingual');
    assert.equal(bilingualConfig.videoSubtitleDisplayMode, 'bilingual');
    assert.equal(bilingualConfig.videoSubtitleAppearance.readingAnnotation, true);
    await visible(showOriginal, false);
    result.cases.push({name: 'translation-only-keeps-reading-preference-and-explicit-action-restores-bilingual', passed: true, onAppearance});
    await menu.locator('[data-mode="original-only"]').click();
    await toggle.click();
    await waitConfig(control, false);

    diagnostics.setPhase('downloads');
    await disclosure.click();
    await visible(downloads);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    const actions = await downloads.locator('[data-action]').evaluateAll(nodes => nodes.map(node => node.dataset.action));
    assert.deepEqual(actions, ['download-subtitles', 'download-translated-subtitles', 'download-bilingual-subtitles']);
    await shoot('menu-downloads-expanded');
    await page.keyboard.press('Escape');
    await visible(menu);
    await visible(downloads, false);
    assert.equal(await disclosure.evaluate(el => el === document.activeElement), true);
    await disclosure.click();
    const originalPromise = page.waitForEvent('download', {timeout: 15000});
    await downloads.locator('[data-action="download-subtitles"]').click();
    const original = await originalPromise;
    const originalPath = path.join(artifactsDir, 'original.srt');
    await original.saveAs(originalPath);
    const originalText = fs.readFileSync(originalPath, 'utf8');
    assert.match(originalText, /Reading annotations help you follow along/);
    assert.match(originalText, /00:00:00,000 --> 00:00:01,600/);
    result.cases.push({name: 'download-disclosure-escape-and-original-srt', passed: true, actions, file: 'original.srt'});
    for (const [action, name] of [['download-translated-subtitles', 'translated'], ['download-bilingual-subtitles', 'bilingual']]) {
      const downloadPromise = page.waitForEvent('download', {timeout: 20000});
      await downloads.locator(`[data-action="${action}"]`).click();
      await menu.locator('[data-export-prompt]').waitFor({state: 'visible'});
      await visible(help, false);
      await menu.locator('[data-export-choice="complete"]').click();
      const download = await downloadPromise;
      const file = `${name}.srt`, target = path.join(artifactsDir, file);
      await download.saveAs(target);
      const text = fs.readFileSync(target, 'utf8');
      assert.match(text, /读音标注帮助你跟读/);
      assert.equal(text.includes('Reading annotations help you follow along.'), name === 'bilingual');
      result.cases.push({name: `${name}-srt-through-collapsed-menu-choice`, passed: true, file});
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-download-status]')?.textContent, null, {timeout: 5000});

    diagnostics.setPhase('narrow-and-language');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#movie_player').evaluate(el => {el.style.width = '358px'; el.style.height = '360px'; el.style.margin = '16px';});
    await page.waitForTimeout(250);
    const narrowBounds = await menu.boundingBox();
    assert.ok(narrowBounds && narrowBounds.x >= 0 && narrowBounds.x + narrowBounds.width <= 390 && narrowBounds.y >= 0, JSON.stringify(narrowBounds));
    const narrowHeader = await headerGeometry();
    assertHeaderFits(narrowHeader);
    await shoot('menu-narrow-390');
    await page.setViewportSize({width: 320, height: 844});
    await page.locator('#movie_player').evaluate(el => {el.style.width = '288px';});
    await page.waitForTimeout(150);
    const narrow320Bounds = await menu.boundingBox();
    assert.ok(narrow320Bounds && narrow320Bounds.x >= 0 && narrow320Bounds.x + narrow320Bounds.width <= 320 && narrow320Bounds.y >= 0, JSON.stringify(narrow320Bounds));
    const narrow320Header = await headerGeometry();
    assertHeaderFits(narrow320Header);
    assert.equal(await menu.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await shoot('menu-narrow-320');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#movie_player').evaluate(el => {el.style.width = '358px';});
    await persist(control, {uiLanguage: 'en-US', theme: 'light'});
    await page.waitForFunction(() => document.querySelector('[data-action="toggle-reading-annotation"]')?.getAttribute('aria-label') === 'Reading annotations');
    const localized = await toggle.getAttribute('aria-label') || (await toggle.textContent()).trim();
    assert.equal(localized, 'Reading annotations');
    assert.equal(await toggle.locator('svg').count(), 1);
    const englishHeader = await headerGeometry();
    assertHeaderFits(englishHeader);
    await helpButton.hover();
    await visible(help);
    assert.match(await help.textContent(), /pinyin|roman/i);
    await shoot('menu-english-help-390');
    const horizontalOverflow = await menu.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(horizontalOverflow, false);
    result.cases.push({name: 'narrow-layout-and-live-locale-refresh-preserve-controls', passed: true, narrowBounds, narrowHeader, narrow320Bounds, narrow320Header, englishHeader, horizontalOverflow,
      themeNote: 'Video menu uses its existing fixed dark palette, including when the extension theme preference is light.'});
    }
    result.translationRequests = await background.evaluate(() => globalThis.__videoMenuUiTranslations);
    result.unexpectedNetwork.push(...await background.evaluate(() => globalThis.__videoMenuUiUnexpectedNetwork));
    assert.deepEqual(result.unexpectedNetwork, []);
    assert.equal(session.windowPlacement.browserFrontmost, false);
    checkFocus();
    result.focusEvents = {monitoring: 'native macOS application activation events throughout launch and verification', browserActivations: focusMonitor.events.filter(event => event.pid === browserPid).length};
    await diagnostics.flush();
    diagnostics.assertClean();
    assert.equal(result.geometryFailures?.length || 0, 0, 'Subtitle geometry changed when interacting with the menu; see subtitle-geometry.json');
    result.ok = true;
  } catch (error) {
    primaryError = error;
    result.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({path: path.join(artifactsDir, 'failure.png')});
        result.screenshots.push('failure.png');
      } catch (screenshotError) {result.failureScreenshotError = screenshotError.stack || String(screenshotError);}
    }
  } finally {
    await finalizeRun({diagnostics, result, artifactsDir, primaryError,
      cleanup: [{stage: 'owned-browser-close', action: async () => {
        if (session) {await session.close(); browserClosed = true; result.browserClosed = true;}
        else if (!launchStarted) browserClosed = true;
        else result.retainedProfileAfterUncertainLaunch = profileDir;
      }},
        {stage: 'focus-monitor-stop', action: async () => {if (focusMonitor) {await focusMonitor.stop(); result.focusEvents = {monitoring: 'native macOS application activation events', browserActivations: focusMonitor.events.filter(event => event.pid === browserPid).length, observerClosed: true};}}},
        // 浏览器主进程退出后，子进程仍可能短暂写入自身 profile；只对本次目录有限重试，失败仍须报告。
        {stage: 'temporary-profile-remove', action: async () => {if (browserClosed) {fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); result.profileRemoved = true;}}}],
      emitReport: () => {
        diagnostics.write(artifactsDir, result);
        console.log(JSON.stringify({ok: result.ok, error: result.error, cases: result.cases, runtimeCounts: result.runtimeDiagnostics?.counts, launchMode: result.launchMode, focusPolicy: result.focusPolicy, windowPlacement: result.windowPlacement, focusEvents: result.focusEvents, browserClosed: result.browserClosed, profileRemoved: result.profileRemoved, artifactsDir}, null, 2));
      },
    });
  }
  if (primaryError) throw primaryError;
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
