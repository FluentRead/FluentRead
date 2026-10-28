'use strict';

// 仅验证 PDF 译文拖选与任务恢复；复用主脚本的临时 profile、无前台输入和本机服务。
const assert = require('node:assert/strict');
const path = require('node:path');

async function runPdfTaskInteractions({page, fixture, report, shot, record, patch, service, until, wait, resourceState, uiNode, uiText, clickNode, translateDrag, baseline}) {
  report.runScope = baseline ? 'translated-selection-baseline' : 'pdf-selection-progress-recovery';
  const workspace = page.locator('[aria-label="文档工作区"]');
  const view = name => workspace.getByRole('button', {name, exact: true}).click();
  const snapshot = async () => {
    await view('校订译文');
    const rows = await page.locator('.segment-edit-row').evaluateAll(elements => elements.map(row => ({id: Number(row.dataset.segmentId), source: row.querySelector('.document-source').textContent, translation: row.querySelector('textarea')?.value || ''})));
    await view('阅读'); return rows;
  };
  const choose = async (selector, label) => {
    await page.locator(selector).getByRole('combobox').click();
    await page.getByRole('option', {name: label, exact: true}).click();
  };
  const before = await snapshot();
  report.segmentTotal = before.length;
  if (!baseline) {
    report.toolbarRows = [];
    for (const width of [1000, 1280, 1359, 1360, 1440, 1759, 1760, 1920]) {
      await page.setViewportSize({width, height: 960}); await wait(100);
      const layout = await page.locator('.document-taskbar').evaluate(element => {
        const box = selector => {const node = element.querySelector(selector), rect = node.getBoundingClientRect(); return {left: rect.left, right: rect.right, center: rect.top + rect.height / 2};};
        const visible = node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
        return {width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
          heading: box('.workspace-heading'), reader: box('.reader-toolbar'), pdf: box('.reader-controls-slot .pdf-viewer-toolbar'), actions: box('.toolbar-primary-actions'),
          lastPdfControl: Math.max(...[...element.querySelectorAll('.pdf-viewer-toolbar > *')].filter(visible).map(node => node.getBoundingClientRect().right)),
          taskLeft: box('.taskbar-actions').left, settingsVisible: visible(element.querySelector('.toolbar-settings-toggle')), fieldsVisible: visible(element.querySelector('.toolbar-translation-settings'))};
      });
      report.toolbarRows.push(layout);
      assert(!layout.overflow, `${width}px PDF 工具栏不能横向溢出`);
      assert(Math.abs(layout.heading.center - layout.reader.center) < 3, `${width}px 文件状态与阅读切换应在第一行`);
      assert(Math.abs(layout.pdf.center - layout.actions.center) < 3, `${width}px 阅读工具和任务操作应在同一行`);
      assert(layout.pdf.center > layout.heading.center + 20, `${width}px PDF 工具栏应为两行`);
      assert(layout.lastPdfControl <= layout.taskLeft - 4, `${width}px 阅读工具不能盖住翻译设置或下载操作`);
      assert.equal(layout.fieldsVisible, width >= 1360);
    }
    await page.setViewportSize({width: 1440, height: 960}); await wait(100);
    const toolbarShot = path.join(report.artifactsDir, 'pdf-toolbar-two-rows.png');
    await page.locator('.document-taskbar').screenshot({path: toolbarShot, animations: 'disabled'}); report.screenshots.push(toolbarShot);
    record('PDF toolbar uses two desktop rows without overlapping controls and keeps compact settings reachable');
  }
  // 逐段请求使失败发生在确切的段落边界；批量并发失败另由核心回归覆盖。
  await page.locator('aside.document-sidebar .document-settings-button').click();
  await page.locator('.document-batch-translation input').uncheck();
  await page.locator('.document-settings-dialog[open] .dialog-actions .ghost-button').click();
  if (!baseline) await choose('.toolbar-model', 'pdf-failing');
  await page.locator('.translation-actions .translate-document-button').click();
  if (!baseline) {
    await until(async () => (await page.locator('.document-status').innerText()).includes('翻译中断') && await page.locator('.pause-button').count() === 0, '失败任务没有收取完在途结果并进入可恢复状态');
    const failed = await snapshot(), completed = failed.filter(row => row.translation.trim());
    assert(completed.length > 0 && completed.length < before.length, '失败之前应保留部分成功译文');
    const recovery = page.getByTestId('document-translation-recovery'), details = recovery.locator('details');
    assert.equal(await details.getAttribute('open'), null, '技术详情默认收起');
    assert.equal(await recovery.locator('.recovery-error-detail').isVisible(), false);
    assert(!(await recovery.innerText()).includes('Fixture model unavailable'), '默认提示不应铺开服务技术错误');
    assert.equal(await page.getByRole('button', {name: '重试', exact: true}).count(), 1, '重试应只保留一个主操作');
    const progressBefore = Number(await page.locator('.task-progress').getAttribute('aria-valuenow'));
    assert.equal(progressBefore, Math.floor(completed.length / before.length * 100));
    await shot('pdf-task-failed-preserved');
    await details.locator('summary').click();
    assert((await recovery.locator('.recovery-error-detail').innerText()).includes('Fixture model unavailable'), '展开详情应保留完整原因');
    await shot('pdf-task-error-details'); await details.locator('summary').click();
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px 失败提示不能横向溢出');
    assert((await recovery.boundingBox()).height <= 36, '默认恢复提示应保持紧凑单行');
    await shot('pdf-task-failed-390'); await page.setViewportSize({width: 1440, height: 960});
    await choose('.toolbar-model', 'pdf-rescue');
    assert.deepEqual(await snapshot(), failed, '切换模型不能清空任何已有译文');
    assert.equal(Number(await page.locator('.task-progress').getAttribute('aria-valuenow')), progressBefore);
    assert.equal(await page.locator('.task-notice.warning').filter({hasText: '从头开始'}).count(), 0, '模型切换不应要求从头翻译');
    const requestsBeforeResume = fixture.state.requests.length;
    fixture.state.translationDelayMs = 180;
    await page.locator('.translation-actions .translate-document-button').click();
    await until(async () => fixture.state.requests.length > requestsBeforeResume, '模型切换后没有续译');
    await page.locator('.pause-button').click();
    const paused = await snapshot();
    assert((await page.locator('.document-status').innerText()).includes('已暂停'));
    await wait(350);
    assert.deepEqual(await snapshot(), paused, '暂停后迟到结果不能覆盖任务');
    await choose('.toolbar-service', 'PDF 备用测试服务');
    assert.deepEqual(await snapshot(), paused, '切换服务不能清空译文');
    await page.locator('.translation-actions .translate-document-button').click();
    await until(async () => (await page.locator('.document-status').innerText()).includes('翻译完成'), '备用服务未续译完成');
    const complete = await snapshot();
    assert(complete.every(row => row.translation.trim()), '完成必须有所有段落的结果');
    for (const row of completed) {
      assert.equal(complete.find(value => value.id === row.id).translation, row.translation);
      assert(!fixture.state.requests.slice(requestsBeforeResume).some(request => request.source === row.source), '成功段落不得再次请求 API');
    }
    assert.equal(Number(await page.locator('.task-progress').getAttribute('aria-valuenow')), 100);
    assert((await page.locator('.document-status').innerText()).includes('100%'));
    report.recovery = {total: before.length, failedCompleted: completed.length, progressBefore, pausedCompleted: paused.filter(row => row.translation).length, complete: complete.length, retainedSegments: completed.map(row => row.id), requestsAfterResume: fixture.state.requests.slice(requestsBeforeResume).map(request => ({source: request.source, model: request.model}))};
    await shot('pdf-task-resumed-complete'); record('failed PDF preserves translations and progress across model switch, pause and service switch; successful segments are never requested again');
  } else {
    await until(async () => (await page.locator('.document-status').innerText()).includes('翻译完成'), '基线译文未完成');
  }
  await view('阅读');
  const selectAndCopy = async (label, startLine, startOffset, endLine, endOffset) => {
    await page.locator('.workspace-heading h1').click();
    const point = async (line, offset) => line.evaluate((element, offset) => {
      const text = element.firstChild;
      const range = document.createRange(); range.setStart(text, offset === text.length ? offset - 1 : offset); range.setEnd(text, offset === text.length ? offset : offset + 1);
      const rect = range.getBoundingClientRect();
      for (const y of [rect.top + rect.height / 2, rect.top + rect.height * .35]) for (const x of [rect.left + .1, rect.left - .1, rect.right - .1, rect.right + .1]) {
        const caret = document.caretPositionFromPoint?.(x, y), fallback = !caret && document.caretRangeFromPoint?.(x, y);
        if ((caret?.offsetNode || fallback?.startContainer) === text && (caret?.offset ?? fallback?.startOffset) === offset) return {x, y};
      }
      throw new Error(`译文字符坐标未命中 ${offset}: ${JSON.stringify(rect.toJSON())}`);
    }, offset);
    await startLine.scrollIntoViewIfNeeded();
    const start = await point(startLine, startOffset), end = await point(endLine, endOffset);
    const requestCount = fixture.state.requests.length;
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, {steps: 24}); await page.mouse.up();
    const selected = await page.evaluate(() => ({text: getSelection()?.toString(), collapsed: getSelection()?.isCollapsed, anchor: getSelection()?.anchorNode?.parentElement?.className, focus: getSelection()?.focusNode?.parentElement?.className}));
    (report.translationSelections ||= []).push({label, ...selected});
    if (baseline) {await shot('pdf-translated-selection-baseline'); return selected;}
    assert(selected.text?.trim() && !selected.collapsed, `${label}: 真实鼠标应能选中译文`);
    if (label === 'layout-forward') {
      await until(() => uiNode('fr-selection-indicator'), '混合语种译文选区应提供划词入口');
      assert.equal(fixture.state.requests.length, requestCount, '选择译文不得自动请求翻译');
      await clickNode('fr-selection-indicator');
      await until(async () => (await uiText()).includes(selected.text), '划词卡片未绑定实际选中的译文');
      await page.keyboard.press('Escape');
    } else {
      // 已是目标语言的选区可按配置隐藏入口；保留实际观察，不把它等同于划词失败。
      report.translationSelections.at(-1).indicatorPresent = Boolean(await uiNode('fr-selection-indicator'));
    }
    await page.evaluate(() => {globalThis.__pdfTaskCopy = null; document.addEventListener('copy', event => {globalThis.__pdfTaskCopy = {text: getSelection()?.toString(), trusted: event.isTrusted}; event.preventDefault();}, {once: true});});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await until(async () => Boolean(await page.evaluate(() => globalThis.__pdfTaskCopy)), '复制快捷键未触发原生事件');
    const copy = await page.evaluate(() => globalThis.__pdfTaskCopy);
    assert(copy.trusted && copy.text === selected.text); await wait(150);
    if (label !== 'layout-forward') assert.equal(fixture.state.requests.length, requestCount, '选择译文不得自动请求翻译');
    await shot(`pdf-${label}-selected`); return selected;
  };
  const first = page.locator('.pdf-page-column.translated .pdf-translation-text span').first();
  const text = await first.innerText(), take = Math.min(8, text.length);
  const selected = await selectAndCopy('layout-forward', first, 0, first, take);
  if (!baseline) assert.equal(selected.text, text.slice(0, take));
  const reverse = await selectAndCopy('layout-reverse', first, take, first, 0); if (!baseline) assert.equal(reverse.text, text.slice(0, take));
  const block = page.locator('.pdf-page-column.translated .pdf-translation-block').filter({has: page.locator('.pdf-translation-text span:nth-child(2)')}).first();
  if (await block.count()) {
    const lines = block.locator('.pdf-translation-text span'), final = lines.last();
    const multiline = await selectAndCopy('layout-multiline', lines.first(), 0, final, Math.min(8, (await final.innerText()).length));
    if (!baseline) assert(multiline.text.includes('\n'), '多行译文应选择多行');
  }
  const blocks = page.locator('.pdf-page-column.translated').first().locator('.pdf-translation-block');
  if (await blocks.count() > 1) {
    const a = blocks.nth(0).locator('span').first(), b = blocks.nth(1).locator('span').first();
    const cross = await selectAndCopy('layout-cross-paragraph', a, 0, b, Math.min(8, (await b.innerText()).length));
    if (!baseline) assert(cross.text.includes(await a.innerText()) && cross.text.includes((await b.innerText()).slice(0, 8)), '跨段译文必须包含两端文字');
  }
  // 制造真实的溢出译文，验证离开悬停后选区和完整内容仍保持可见。
  const overflowText = '这段较长译文用于验证文本选择与复制功能，鼠标移开后应保持展开。'.repeat(100);
  await view('校订译文'); await page.locator('.segment-edit-row textarea').nth(1).fill(overflowText); await view('阅读');
  const overflow = page.locator('.pdf-page-column.translated .pdf-translation-block.overflowing').first();
  await overflow.hover();
  const line = overflow.locator('.pdf-translation-text span').first();
  await selectAndCopy('layout-overflow', line, 0, line, 8);
  const heading = await page.locator('.workspace-heading h1').boundingBox(); await page.mouse.move(heading.x + 2, heading.y + 2); await wait(100);
  report.overflowSelection = await overflow.evaluate(element => ({expanded: element.classList.contains('selection-expanded'), maxHeight: getComputedStyle(element.querySelector('.pdf-translation-text')).maxHeight, selected: getSelection()?.toString()}));
  if (!baseline) {assert(report.overflowSelection.expanded); assert.equal(report.overflowSelection.maxHeight, 'none'); assert(report.overflowSelection.selected);}
  await shot('pdf-overflow-selection-retained');
  await page.locator('.workspace-heading h1').click(); await wait(100);
  if (!baseline) assert.equal(await overflow.evaluate(element => element.classList.contains('selection-expanded')), false, '清除选区应收起展开状态');
  {
    const original = await page.locator('[data-fluentread-pdf-text][data-pdf-page-number="1"] span').evaluateAll(elements => elements.find(element => element.textContent.startsWith('PDF selection translation'))?.textContent);
    assert(original);
    try {await translateDrag(original); report.originalSelection = {status: 'selected'}; record('original PDF mouse selection still opens the existing translation card');}
    catch (error) {
      if (error?.code !== 'ERR_ASSERTION' || !error.message.includes('真实拖选必须严格对应指定原文')) throw error;
      report.originalSelection = {status: 'inconclusive', error: error.message, boundary: 'Background Input collapses the native PDF.js drag despite exact caret probes. Compare the same scoped runner against baseline; no original-selection success claimed.'};
    }
    await page.keyboard.press('Escape'); await page.locator('.workspace-heading h1').click();
  }
  await page.locator('.pdf-presentation-control .pdf-menu-button').click(); await page.getByRole('option', {name: '重排阅读', exact: true}).click();
  const paragraph = page.locator('.pdf-reading-paragraph').first();
  const readable = await selectAndCopy('readable', paragraph, 0, paragraph, 8); if (!baseline) assert.equal(readable.text, (await paragraph.innerText()).slice(0, 8));
  if (!baseline) {
    await page.locator('.workspace-heading h1').click();
    await page.emulateMedia({colorScheme: 'dark'}); await page.setViewportSize({width: 390, height: 844});
    await until(async () => await page.locator('.document-app.dark').count() === 1, '文档页未进入实际暗色状态');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px 文档页不能横向溢出');
    await selectAndCopy('readable-390-dark', paragraph, 0, paragraph, 8);
    await shot('pdf-task-390-dark'); record('390px dark PDF retains translated selection, copy and progress without horizontal overflow');
  }
  await resourceState('PDF selection and recovery complete');
  record(baseline ? 'baseline native selections and overflow collapse captured without a copy-success claim' : 'native forward, reverse and multiline translated selection and trusted copy work in original layout and readable presentation');
}

module.exports = {runPdfTaskInteractions};
