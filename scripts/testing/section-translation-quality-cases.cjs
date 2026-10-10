'use strict';
/**
 * @file scripts/testing/section-translation-quality-cases.cjs
 * 文件职责：为局部翻译生产浏览器脚本提供可独立筛选的性能、动态页面与恢复可靠性专项。
 * 主要内容：用真实 CDP 指针和按键验证静止指针重命中、嵌套滚动、Shadow DOM 原文预览、局部失败重试、取消后的迟到结果、较大区域让帧与再次翻译去重，并检查 light/dark 与 390px 控件几何。
 * 模块边界：只调用测试宿主提供的隔离浏览器和受控 Google transport，不读取用户浏览器配置、不接入在线翻译服务，也不修改产品实现。
 */
const assert = require('node:assert/strict');

async function runSectionQualityCases(harness) {
  const {page, worker, popup, tabId, report, patch, startFromPopupMessage, picker, pickerState, pickerActive,
    hover, center, clickPickerButton, wait, waitLabel, hasTranslation, translationCount, shot, noticeText,
    setCurrentCase} = harness;
  const requestCount = () => worker.evaluate(() => globalThis.__sectionFixture.requests.length);
  const fixtureControl = values => worker.evaluate(values => Object.assign(globalThis.__sectionFixture, values), values);
  let caseConfiguration = {};
  const configure = async values => {
    await patch(values);
    caseConfiguration = {...caseConfiguration, ...values};
  };
  const sourceIn = text => wait(async () => (await pickerState())?.preview?.includes(text), 5000, `source preview: ${text}`);
  const restoreAll = () => popup.evaluate(tab => chrome.tabs.sendMessage(tab, {type: 'contextMenuTranslate', action: 'restore'}), tabId);
  const readyForCase = async () => {
    if (await pickerActive()) await page.keyboard.press('Escape');
    await restoreAll();
    await wait(async () => (await worker.evaluate(() => globalThis.__sectionFixture.active)) === 0, 10000, 'fixture transports settled');
    await page.evaluate(() => {document.querySelector('#quality-fixture')?.remove(); scrollTo(0, 0);});
    await fixtureControl({delayMs: 60, failureMatch: '', maxActive: 0});
    await configure({on: true, service: 'google', to: 'zh-Hans', display: 1, maxConcurrentTranslations: 4,
      quickTranslationProfiles: [], sectionTranslationHotkeyEnabled: false, nativeBatchTranslationEnabled: {google: true}, theme: 'light'});
    await page.setViewportSize({width: 1280, height: 900});
    await page.emulateMedia({colorScheme: 'light', reducedMotion: 'reduce'});
    await page.waitForTimeout(120);
  };
  const region = async (markup, style = '') => page.evaluate(({markup, style}) => {
    const region = document.createElement('section');
    region.id = 'quality-fixture';
    region.style.cssText = `margin:24px;padding:20px;border:1px solid #aaa;background:var(--quality-bg,#fff);color:var(--quality-fg,#111);${style}`;
    region.innerHTML = markup;
    document.body.prepend(region);
  }, {markup, style});
  const lock = async selector => {
    const point = await hover(selector);
    await page.mouse.click(point.x, point.y);
    await wait(async () => (await pickerState())?.selection === 'locked', 5000, 'locked section');
  };
  const selectContainer = async selector => {
    await startFromPopupMessage();
    await lock(selector);
    await clickPickerButton('.fr-section-expand');
    await sourceIn('Quality');
  };
  const caseDone = name => {
    report.cases.push(name);
    (report.qualityCaseConfigurations ??= []).push({case: name, service: caseConfiguration.service,
      target: caseConfiguration.to, configuredConcurrency: caseConfiguration.maxConcurrentTranslations,
      nativeGoogleBatching: caseConfiguration.nativeBatchTranslationEnabled?.google,
      theme: caseConfiguration.theme, transport: 'deterministic Google fixture'});
  };
  const selected = new Set(harness.selectedCases);
  let name;

  if (selected.has('performance')) {
  await readyForCase();
  name = 'large selected region yields rendering frames, honors provider concurrency and preserves neighbors';
  setCurrentCase(name);
  const largeParagraphs = 180;
  await region(`<article id="quality-large-region" style="padding:12px">${Array.from({length: largeParagraphs}, (_, index) => `<p id="large-${index}">Quality performance paragraph ${index} has a stable original source ${Array.from({length: 12}, (_, part) => `<span> readable fragment ${part}</span>`).join('')}.</p>`).join('')}</article><p id="large-neighbor">Quality performance neighbor must not enter the selected translation workload.</p>`);
  await fixtureControl({delayMs: 70, maxActive: 0});
  const largeBefore = await requestCount();
  await startFromPopupMessage();
  await lock('#large-0');
  await page.evaluate(() => {
    window.__sectionPerformance = {startedAt: performance.now(), lastFrameAt: performance.now(), frameCount: 0, maxFrameGapMs: 0, maxTimerDelayMs: 0, timerCount: 0, longTasks: [], active: true};
    const sample = time => {
      const state = window.__sectionPerformance;
      state.frameCount += 1;
      state.maxFrameGapMs = Math.max(state.maxFrameGapMs, time - state.lastFrameAt);
      state.lastFrameAt = time;
      if (state.active) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    // 每次 tick 的下个期限必须在安排计时器时冻结，才能观测主线程排队延迟。
    const probe = () => {
      const state = window.__sectionPerformance;
      const expectedAt = performance.now() + 16;
      state.timerHandle = setTimeout(() => {
        state.timerCount += 1;
        state.maxTimerDelayMs = Math.max(state.maxTimerDelayMs, performance.now() - expectedAt);
        if (state.active) probe();
      }, 16);
    };
    probe();
    window.__sectionLongTasks = new PerformanceObserver(list => window.__sectionPerformance.longTasks.push(...list.getEntries().map(entry => ({startTime: entry.startTime, duration: entry.duration}))));
    window.__sectionLongTasks.observe({type: 'longtask', buffered: false});
  });
  await clickPickerButton('.fr-section-expand');
  await wait(async () => {
    const state = await pickerState();
    return state?.meta === '文章' && state.confirmDisabled === false;
  }, 10000, 'large-region preview becomes actionable');
  report.largePreview = await page.evaluate(() => {
    const state = window.__sectionPerformance;
    state.confirmedAt = performance.now();
    return {elapsedMs: state.confirmedAt - state.startedAt, frameCount: state.frameCount};
  });
  report.largePreview.requestsBeforeConfirm = (await requestCount()) - largeBefore;
  assert.equal(report.largePreview.requestsBeforeConfirm, 0, 'large-region preview is local and makes no provider request');
  await page.keyboard.press('Enter');
  await wait(async () => (await requestCount()) > largeBefore, 10000, 'large-region discovery reached its first provider request');
  report.largeFirstRequest = await page.evaluate(() => ({observedAfterConfirmationMs: performance.now() - window.__sectionPerformance.confirmedAt, frameCount: window.__sectionPerformance.frameCount}));
  await wait(async () => (await translationCount('#quality-large-region p')) > 0, 10000, 'incremental first translation');
  report.largeFirstProgress = await page.evaluate(() => ({elapsedAfterConfirmationMs: performance.now() - window.__sectionPerformance.confirmedAt, frameCount: window.__sectionPerformance.frameCount}));
  await wait(async () => (await translationCount('#quality-large-region p')) === largeParagraphs, 45000, 'complete large selected region');
  const performanceResult = await page.evaluate(() => {
    const state = window.__sectionPerformance;
    state.active = false;
    clearTimeout(state.timerHandle);
    window.__sectionLongTasks.disconnect();
    return {...state, longTasks: state.longTasks.map(task => ({duration: task.duration,
      relativeToProbeMs: task.startTime - state.startedAt, phase: task.startTime < state.confirmedAt ? 'preview' : 'confirmed-region'})),
      elapsedMs: performance.now() - state.startedAt, longTaskTotalMs: state.longTasks.reduce((total, task) => total + task.duration, 0)};
  });
  const maxActive = await worker.evaluate(() => globalThis.__sectionFixture.maxActive);
  report.largeRegion = {paragraphs: largeParagraphs, originalInlineNodes: largeParagraphs * 12, requestCount: (await requestCount()) - largeBefore, maxProviderConcurrency: maxActive, ...performanceResult};
  delete report.largeRegion.startedAt; delete report.largeRegion.lastFrameAt; delete report.largeRegion.active; delete report.largeRegion.confirmedAt; delete report.largeRegion.timerHandle;
  assert.ok(performanceResult.frameCount > 5, 'rendering remains active throughout regional work');
  assert.ok(performanceResult.maxFrameGapMs < 750, `large-region rendering pause exceeded 750 ms: ${performanceResult.maxFrameGapMs}`);
  assert.ok(performanceResult.maxTimerDelayMs < 750, `large-region timer delay exceeded 750 ms: ${performanceResult.maxTimerDelayMs}`);
  assert.ok(maxActive <= 4, `configured provider concurrency exceeded: ${maxActive}`);
  assert.equal(await hasTranslation('#large-neighbor'), false);
  assert.equal(await page.locator('#quality-large-region .fluent-read-bilingual-content').count(), largeParagraphs);
  assert.equal(await page.locator('#quality-large-region .fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
  await shot('quality-05-large-region');
  caseDone(name);
  }

  if (selected.has('layout')) {
  await readyForCase();
  name = 'stationary pointer follows layout changes while a locked selection keeps its source';
  setCurrentCase(name);
  await region('<p id="layout-alpha" style="position:absolute;left:20px;right:20px;top:20px;margin:0;height:80px">Quality layout alpha remains the first source until the webpage moves it.</p><p id="layout-beta" style="position:absolute;left:20px;right:20px;top:120px;margin:0;height:80px">Quality layout beta moves under the pointer without another mouse gesture.</p>', 'position:relative;height:240px');
  const layoutBefore = await requestCount();
  await startFromPopupMessage();
  await hover('#layout-alpha');
  await sourceIn('Quality layout alpha');
  await page.evaluate(() => {
    document.querySelector('#layout-alpha').style.top = '120px';
    document.querySelector('#layout-beta').style.top = '20px';
  });
  await sourceIn('Quality layout beta');
  const point = await center('#layout-beta');
  await page.mouse.click(point.x, point.y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await page.evaluate(() => {document.querySelector('#layout-beta').style.top = '120px';});
  await sourceIn('Quality layout beta');
  await wait(async () => {
    const source = await page.locator('#layout-beta').boundingBox(), state = await pickerState();
    return Math.abs(state.rect.y - (source.y - 3)) <= 2;
  });
  assert.equal(await requestCount(), layoutBefore, 'layout refresh and lock send no requests');
  await shot('quality-01-stationary-layout');
  await page.keyboard.press('Escape');
  caseDone(name);
  }

  if (selected.has('nested-scroll')) {
  await readyForCase();
  name = 'nested scrolling re-hits an unlocked preview and keeps a locked paragraph attached';
  setCurrentCase(name);
  await region('<div id="quality-scroll" style="overflow:auto;height:160px;border:1px solid #ddd"><p id="scroll-alpha" style="height:120px;margin:0;padding:8px">Quality scroll alpha is initially visible in a nested scrolling reader.</p><p id="scroll-beta" style="height:120px;margin:0;padding:8px">Quality scroll beta becomes visible under the same pointer after scrolling.</p><p id="scroll-gamma" style="height:120px;margin:0;padding:8px">Quality scroll gamma must remain original outside the selected paragraph.</p></div>');
  await startFromPopupMessage();
  await hover('#scroll-alpha');
  await sourceIn('Quality scroll alpha');
  // 段落包含 padding；按真实 border-box 高度滚动，保证原指针离开首段并命中第二段。
  await page.locator('#quality-scroll').evaluate(element => {element.scrollTop = document.querySelector('#scroll-alpha').offsetHeight;});
  await sourceIn('Quality scroll beta');
  const betaPoint = await center('#scroll-beta');
  await page.mouse.click(betaPoint.x, betaPoint.y);
  await wait(async () => (await pickerState())?.selection === 'locked');
  await page.locator('#quality-scroll').evaluate(element => {element.scrollTop += 20;});
  await wait(async () => {
    const source = await page.locator('#scroll-beta').boundingBox(), state = await pickerState();
    return state.preview.includes('Quality scroll beta') && Math.abs(state.rect.y - (source.y - 3)) <= 2;
  });
  await page.keyboard.press('Enter');
  await wait(async () => await hasTranslation('#scroll-beta'));
  assert.equal(await hasTranslation('#scroll-alpha'), false);
  assert.equal(await hasTranslation('#scroll-gamma'), false);
  assert.equal(await page.locator('#scroll-beta .fluent-read-bilingual-content').count(), 1);
  await shot('quality-02-nested-scroll-selected');
  caseDone(name);
  }

  if (selected.has('replacement')) {
  await readyForCase();
  name = 'removing a locked source cannot translate detached content and permits selecting its replacement';
  setCurrentCase(name);
  await region('<p id="removed-source">Quality detached source must never reach the provider after the webpage replaces it.</p>');
  const removedBefore = await requestCount();
  await startFromPopupMessage();
  await lock('#removed-source');
  await page.locator('#removed-source').evaluate(element => {
    const replacement = document.createElement('p');
    replacement.id = 'replacement-source';
    replacement.textContent = 'Quality replacement source is the new connected content under the pointer.';
    element.replaceWith(replacement);
  });
  await wait(async () => (await pickerState())?.selection === 'preview');
  assert.equal(await requestCount(), removedBefore);
  await hover('#replacement-source');
  await sourceIn('Quality replacement source');
  await lock('#replacement-source');
  await page.keyboard.press('Enter');
  await wait(async () => await hasTranslation('#replacement-source'));
  const detachedRequests = await worker.evaluate(offset => globalThis.__sectionFixture.requests.slice(offset), removedBefore);
  assert.ok(detachedRequests.every(entry => !entry.origin.includes('Quality detached source')));
  caseDone(name);
  }

  if (selected.has('boundary')) {
  name = 'connected pending paragraphs moved outside the selected region never reach the provider in light or Shadow DOM';
  setCurrentCase(name);
  report.pendingBoundary = [];
  for (const structure of ['light', 'shadow']) {
    await readyForCase();
    const marker = `BOUNDARY_MOVED_${structure.toUpperCase()}`;
    await region(`<article id="quality-boundary-region" style="padding:12px"><p id="boundary-first">Quality boundary first ${structure} paragraph deliberately waits while the host webpage moves another candidate.</p>${structure === 'light'
      ? `<p id="boundary-moved">Quality ${marker} source must never be requested after leaving the selected region.</p>`
      : '<div id="boundary-shadow-host" style="display:block;padding:8px"></div>'}<p id="boundary-last">Quality boundary last ${structure} paragraph is still part of the selected region.</p></article><div id="boundary-neighbor-region" style="padding:12px;border:1px solid #aaa"><p id="boundary-neighbor">Quality boundary neighbor remains outside the selection.</p></div>`);
    if (structure === 'shadow') {
      await page.evaluate(marker => {
        const root = document.querySelector('#boundary-shadow-host').attachShadow({mode: 'open'});
        root.innerHTML = `<p id="boundary-moved">Quality ${marker} source must never be requested after leaving the selected region.</p>`;
      }, marker);
    }
  await configure({maxConcurrentTranslations: 1});
    await fixtureControl({delayMs: 500});
    const before = await requestCount();
    await selectContainer('#boundary-first');
    await page.keyboard.press('Enter');
    await wait(async () => (await requestCount()) > before, 5000, 'first slow request started before moving a pending paragraph');
    await page.evaluate(structure => {
      const moved = structure === 'shadow'
        ? document.querySelector('#boundary-shadow-host').shadowRoot.querySelector('#boundary-moved')
        : document.querySelector('#boundary-moved');
      document.querySelector('#boundary-neighbor-region').appendChild(moved);
      if (!moved.isConnected) throw new Error('boundary fixture must keep its moved source connected');
    }, structure);
    await wait(async () => (await hasTranslation('#boundary-first')) && (await hasTranslation('#boundary-last')), 15000, 'in-region candidates complete after host movement');
    await wait(async () => (await worker.evaluate(() => globalThis.__sectionFixture.active)) === 0);
    await page.waitForTimeout(150);
    const requests = await worker.evaluate(offset => globalThis.__sectionFixture.requests.slice(offset), before);
    assert.ok(requests.every(request => !request.origin.includes(marker)), `${structure}: moved source must not reach the provider`);
    assert.equal(await hasTranslation('#boundary-moved'), false, `${structure}: connected moved source stays original outside the selection`);
    assert.equal(await hasTranslation('#boundary-neighbor'), false);
    assert.equal(await page.locator('#quality-boundary-region .fluent-read-bilingual-content').count(), 2);
    report.pendingBoundary.push({structure, movedSourceStayedConnected: true, movedSourceRequested: false, selectedParagraphsTranslated: 2, dispatchedRequests: requests.length});
  }
  await shot('quality-03-pending-boundary');
  caseDone(name);
  }

  if (selected.has('shadow')) {
  await readyForCase();
  name = 'open Shadow DOM previews only original text and restores then translates without duplicate wrappers';
  setCurrentCase(name);
  await region('<div id="quality-shadow-host" style="display:block;padding:16px;border:1px solid #aaa"></div><p id="quality-shadow-neighbor">Quality shadow neighbor remains original throughout the section interaction.</p>');
  await page.evaluate(() => {
    const root = document.querySelector('#quality-shadow-host').attachShadow({mode: 'open'});
    root.innerHTML = '<p id="shadow-alpha">Quality shadow alpha original is visible in a composed reading region.</p><div id="quality-nested-host" style="display:block"><slot></slot></div>';
    root.querySelector('#quality-nested-host').attachShadow({mode: 'open'}).innerHTML = '<p id="shadow-beta">Quality shadow beta original lives in a nested open web component.</p>';
  });
  const shadowCount = () => page.evaluate(() => {
    const root = document.querySelector('#quality-shadow-host').shadowRoot;
    return [root, root.querySelector('#quality-nested-host').shadowRoot].map(root => root.querySelectorAll('.fluent-read-bilingual-content').length);
  });
  await startFromPopupMessage();
  await lock('#shadow-alpha');
  await clickPickerButton('.fr-section-expand');
  await sourceIn('Quality shadow alpha original');
  assert.ok(!(await pickerState()).preview.includes('【译】'));
  await page.keyboard.press('Enter');
  await wait(async () => (await shadowCount()).every(count => count === 1));
  await startFromPopupMessage();
  await lock('#shadow-alpha');
  await clickPickerButton('.fr-section-expand');
  await waitLabel(/恢复原文/);
  assert.ok((await pickerState()).preview.includes('Quality shadow alpha original') && !(await pickerState()).preview.includes('【译】'));
  await shot('quality-03-shadow-original-preview');
  await page.keyboard.press('Enter');
  await wait(async () => (await shadowCount()).every(count => count === 0));
  await startFromPopupMessage();
  await lock('#shadow-alpha');
  await clickPickerButton('.fr-section-expand');
  await page.keyboard.press('Enter');
  await wait(async () => (await shadowCount()).every(count => count === 1));
  assert.equal(await hasTranslation('#quality-shadow-neighbor'), false);
  caseDone(name);
  }

  if (selected.has('retry')) {
  await readyForCase();
  name = 'partial transport failure keeps successful paragraphs and region retry only requests failed content';
  setCurrentCase(name);
  await region('<article id="quality-retry-region" style="padding:12px"><p id="retry-success">Quality success paragraph remains translated while its neighboring request fails.</p><p id="retry-failed">Quality FAILURE_RETRY paragraph recovers when the user confirms this region again.</p></article><p id="retry-neighbor">Quality retry neighbor must not be translated or included in retries.</p>');
  // 部分成功要求请求之间互相独立；默认 Google 合批失败的语义是整批失败，另有 provider 契约测试。
  await configure({nativeBatchTranslationEnabled: {google: false}, maxConcurrentTranslations: 1});
  await fixtureControl({failureMatch: 'FAILURE_RETRY'});
  const failureBefore = await requestCount();
  await selectContainer('#retry-success');
  await page.keyboard.press('Enter');
  await wait(async () => await hasTranslation('#retry-success'));
  await wait(async () => (await page.locator('#retry-failed .fluent-read-retry-wrapper').count()) === 1, 30000, 'one failed paragraph exposes retry');
  await wait(async () => /失败|重试/.test(await noticeText()), 10000, 'partial failure notice');
  assert.equal(await hasTranslation('#retry-neighbor'), false);
  assert.equal(await page.locator('#retry-success .fluent-read-bilingual-content').count(), 1);
  await fixtureControl({failureMatch: ''});
  const beforeRetry = await requestCount();
  await selectContainer('#retry-success');
  await waitLabel(/翻译剩余 1 段/);
  await page.keyboard.press('Enter');
  await wait(async () => await hasTranslation('#retry-failed'));
  assert.equal(await page.locator('#retry-failed .fluent-read-retry-wrapper').count(), 0);
  assert.equal(await page.locator('#quality-retry-region .fluent-read-bilingual-content').count(), 2);
  const retries = await worker.evaluate(offset => globalThis.__sectionFixture.requests.slice(offset), beforeRetry);
  assert.ok(retries.length > 0 && retries.every(entry => entry.origin.includes('FAILURE_RETRY')), 'successful paragraphs are not requested again');
  assert.equal(await hasTranslation('#retry-neighbor'), false);
  report.partialFailure = {failureMode: 'controlled per-request HTTP 400', nativeGoogleBatching: false, configuredConcurrency: 1, initialRequestCount: beforeRetry - failureBefore, retryRequestCount: retries.length, successfulParagraphPreserved: true};
  await shot('quality-04-partial-failure-recovered');
  caseDone(name);
  }

  if (selected.has('cancel')) {
  await readyForCase();
  name = 'restoring during delayed section translation cancels undispatched work and ignores late transport results';
  setCurrentCase(name);
  const cancellationParagraphs = 36;
  await region(`<article id="quality-cancel-region" style="padding:12px">${Array.from({length: cancellationParagraphs}, (_, index) => `<p id="cancel-${index}">Quality delayed cancellation paragraph ${index} must stay original after restore before completion.</p>`).join('')}</article><p id="cancel-neighbor">Quality cancellation neighbor remains untouched.</p>`);
  await configure({maxConcurrentTranslations: 2});
  await fixtureControl({delayMs: 650});
  const cancellationBefore = await requestCount();
  await selectContainer('#cancel-0');
  await page.keyboard.press('Enter');
  await wait(async () => (await requestCount()) > cancellationBefore, 5000, 'a delayed transport has begun');
  await restoreAll();
  await wait(async () => (await page.locator('#quality-cancel-region .fluent-read-bilingual-content,#quality-cancel-region .fluent-read-loading,#quality-cancel-region .fluent-read-retry-wrapper').count()) === 0, 5000, 'restore clears regional artifacts');
  await wait(async () => (await worker.evaluate(() => globalThis.__sectionFixture.active)) === 0, 5000, 'late fixture results settled');
  await page.waitForTimeout(850);
  const cancellationRequests = (await requestCount()) - cancellationBefore;
  assert.ok(cancellationRequests < cancellationParagraphs, 'restore prevents remaining section candidates from dispatching');
  assert.equal(await page.locator('#quality-cancel-region .fluent-read-bilingual-content,#quality-cancel-region .fluent-read-retry-wrapper').count(), 0, 'late results cannot remount translation');
  assert.equal(await hasTranslation('#cancel-neighbor'), false);
  report.cancellation = {paragraphs: cancellationParagraphs, dispatchedRequests: cancellationRequests, lateResultsIgnored: true};
  await fixtureControl({delayMs: 60});
  await selectContainer('#cancel-0');
  await page.keyboard.press('Enter');
  await wait(async () => (await translationCount('#quality-cancel-region p')) === cancellationParagraphs, 30000, 'region remains usable after cancellation');
  assert.equal(await page.locator('#quality-cancel-region .fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
  caseDone(name);
  }

  if (selected.has('narrow')) {
  await readyForCase();
  name = 'light and dark 390px controls stay visible through lock, range adjustments, reselect and Escape';
  setCurrentCase(name);
  await region('<article id="quality-narrow-region" style="padding:12px"><p id="narrow-alpha">Quality narrow alpha offers a visible original preview on small screens.</p><p id="narrow-beta">Quality narrow beta remains easy to select after choosing another range.</p></article>');
  report.narrowThemes = [];
  for (const theme of ['light', 'dark']) {
    await configure({theme});
    await page.emulateMedia({colorScheme: theme, reducedMotion: 'reduce'});
    await page.setViewportSize({width: 390, height: 780});
    await page.evaluate(dark => {
      document.querySelector('#quality-fixture').style.setProperty('--quality-bg', dark ? '#17191e' : '#fff');
      document.querySelector('#quality-fixture').style.setProperty('--quality-fg', dark ? '#eee' : '#111');
    }, theme === 'dark');
    const beforeNarrow = await requestCount();
    await startFromPopupMessage();
    await lock('#narrow-alpha');
    const controls = await picker(`return [...this.querySelectorAll('.fr-section-button,.fr-section-bar-close')].map(button=>{const rect=button.getBoundingClientRect(),style=getComputedStyle(button);return{text:button.textContent,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,display:style.display,visibility:style.visibility}})`);
    assert.equal(controls.length, 5);
    assert.ok(controls.every(control => control.left >= 0 && control.right <= 390 && control.top >= 0 && control.bottom <= 780 && control.display !== 'none' && control.visibility !== 'hidden'), JSON.stringify(controls));
    await clickPickerButton('.fr-section-expand');
    await waitLabel(/翻译此区域 · 2 段/);
    await clickPickerButton('.fr-section-shrink');
    await sourceIn('Quality narrow alpha');
    await clickPickerButton('.fr-section-reselect');
    await hover('#narrow-beta');
    await sourceIn('Quality narrow beta');
    await shot(`quality-06-narrow-${theme}`);
    await page.keyboard.press('Escape');
    await wait(async () => !(await pickerActive()));
    assert.equal(await requestCount(), beforeNarrow);
    report.narrowThemes.push({theme, viewport: {width: 390, height: 780}, controlsInsideViewport: true, cancelledWithoutRequest: true});
  }
  await page.setViewportSize({width: 1280, height: 900});
  caseDone(name);
  }
}

module.exports = {runSectionQualityCases};
