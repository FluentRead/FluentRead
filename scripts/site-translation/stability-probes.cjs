/**
 * @file scripts/site-translation/stability-probes.cjs
 * 文件职责：对已经完成第二轮全文翻译的真实网页执行明确标记的受控宿主变化回归。
 * 主要内容：检查安静期、等价文本节点替换、译文移除修复、增量正文、恢复重译和停止后的静默；原文与追加段落均绑定保护子树身份并核对全部后代译文，逐步保存证据。
 * 模块边界：仅通过 DOM 与真实快捷键观察生产扩展；不读取内部业务状态、不替换站点网络响应，受控变化不冒充网站原生路由或真实无限滚动。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

/** 所有闭包都在页面中创建；可直接在 DOM 测试环境验证断言所依赖的采样。 */
function installStabilityProbeInPage({key, selector}) {
  if (window[key]) throw new Error('Stability probe key is already in use');
  const wrapperSelector = '.fluent-read-bilingual-content';
  const artifactSelector = '.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper,[data-fr-translation-owned="true"]';
  const excluded = 'pre,code,textarea,input,select,button,[contenteditable="true"],[translate="no"],.notranslate';
  const cleanClone = node => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(artifactSelector).forEach(artifact => artifact.remove());
    clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach(segment => segment.replaceWith(...segment.childNodes));
    return clone;
  };
  const wrappers = owner => [...owner.querySelectorAll(wrapperSelector)].filter(wrapper => wrapper.parentElement === owner);
  const sourceTextNodes = owner => {
    const walker = document.createTreeWalker(owner, 4);
    const result = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.data.trim() && !node.parentElement.closest(`${artifactSelector},${excluded}`)) result.push(node);
    }
    return result;
  };
  const candidates = [...document.querySelectorAll(selector), ...[...document.querySelectorAll(wrapperSelector)].map(node => node.parentElement)];
  const unique = [...new Set(candidates)].filter(node => node?.isConnected && !node.closest(`${artifactSelector},${excluded}`) &&
    wrappers(node).length === 1 && node.querySelectorAll(wrapperSelector).length === 1 && sourceTextNodes(node).length > 0);
  // 正文段落更接近动态内容的真实候选；无段落的列表/标题页面仍可验证原 owner。
  const owner = unique.find(node => node.localName === 'p') || unique[0];
  if (!owner) throw new Error('No translated source owner with one direct wrapper is available for stability probes');
  const sourceClone = cleanClone(owner);
  const baselineHtml = sourceClone.innerHTML;
  const captureProtectedNodes = root => [...root.querySelectorAll(
    'a,code,pre,input,button,select,textarea,svg,math,[translate="no"],.notranslate,[contenteditable]:not([contenteditable="false"])')]
    .filter(node => !node.closest(artifactSelector)).map(node => ({node, html: node.outerHTML}));
  const protectedNodes = captureProtectedNodes(owner);
  const protectedIntact = (root, captured) => captured.every(({node, html}) =>
    node.isConnected && root.contains(node) && node.outerHTML === html);
  const wrapperIds = new WeakMap();
  let nextId = 1;
  const idFor = node => {if (!wrapperIds.has(node)) wrapperIds.set(node, nextId++); return wrapperIds.get(node);};
  let events = [];
  let overflow = 0;
  const additions = [];
  const observeRoots = [owner];
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (!observeRoots.some(root => root === mutation.target || root.contains(mutation.target) ||
        [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node => node === root || node.contains?.(root)))) continue;
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const event = {type: mutation.type, attributeName: mutation.attributeName || null, addedWrappers: 0, removedWrappers: 0,
        insideTranslation: Boolean(target?.closest(wrapperSelector)),
        insideArtifact: Boolean(target?.closest(artifactSelector))};
      for (const [field, nodes] of [['addedWrappers', mutation.addedNodes], ['removedWrappers', mutation.removedNodes]]) {
        for (const node of nodes || []) if (node.nodeType === 1) {
          event[field] += Number(node.matches(wrapperSelector)) + node.querySelectorAll(wrapperSelector).length;
        }
      }
      if (events.length < 1000) events.push(event); else overflow += 1;
    }
  });
  observer.observe(owner.parentElement, {childList: true, subtree: true, characterData: true, attributes: true});
  const inspect = (node, captured) => ({connected: node.isConnected, sourceHtml: cleanClone(node).innerHTML,
    wrappers: wrappers(node).map(wrapper => ({id: idFor(wrapper), text: wrapper.textContent || ''})),
    allWrappers: node.querySelectorAll(wrapperSelector).length,
    protectedIntact: protectedIntact(node, captured),
    nested: node.querySelectorAll(`${wrapperSelector} ${wrapperSelector}`).length,
    artifactCount: node.querySelectorAll(artifactSelector).length,
    loadingCount: node.querySelectorAll('.fluent-read-loading,.fluent-read-retry-wrapper').length});
  const state = {
    owner,
    snapshot: () => ({owner: inspect(owner, protectedNodes), additions: additions.map(({node, html, name, protectedNodes: captured}) =>
      ({name, originalHtml: html, ...inspect(node, captured)})),
      baselineHtml, protectedIntact: protectedIntact(owner, protectedNodes),
      events: [...events], overflow,
      totalWrappers: document.querySelectorAll(wrapperSelector).length,
      totalLoading: document.querySelectorAll('.fluent-read-loading,.fluent-read-retry-wrapper').length,
      nestedWrappers: document.querySelectorAll(`${wrapperSelector} ${wrapperSelector}`).length}),
    reset: () => {observer.takeRecords(); events = []; overflow = 0;},
    replaceSourceText: () => {
      const source = sourceTextNodes(owner)[0];
      if (!source) throw new Error('Source text is unavailable');
      const text = source.data;
      source.replaceWith(document.createTextNode(text));
      return {text, equivalent: true};
    },
    removeTranslation: () => {
      const current = wrappers(owner);
      if (current.length !== 1) throw new Error(`Expected one wrapper before removal, got ${current.length}`);
      const id = idFor(current[0]); current[0].remove(); return {removedWrapperId: id};
    },
    append: name => {
      // 使用来源的标签与 class 保留站点适配语义；去除 ID 避免复制宿主唯一标识。
      const node = sourceClone.cloneNode(true);
      node.removeAttribute('id');
      node.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
      node.removeAttribute('style');
      node.append(document.createTextNode(` This additional reading passage verifies ${name} content after a page update.`));
      const html = node.innerHTML;
      additions.push({node, html, name, protectedNodes: captureProtectedNodes(node)}); observeRoots.push(node);
      owner.parentElement.insertBefore(node, owner.nextSibling);
      node.scrollIntoView?.({block: 'center', behavior: 'instant'});
      return {name, tag: node.localName, sourceHtml: html};
    },
    dispose: () => {observer.disconnect(); additions.forEach(({node}) => node.remove()); delete window[key];},
  };
  window[key] = state;
  owner.scrollIntoView?.({block: 'center', behavior: 'instant'});
  return {ownerTag: owner.localName, sourceText: sourceClone.textContent, baselineHtml,
    boundary: 'Controlled host DOM changes on a real page; not native site interaction or provider quality proof'};
}

function assertStableSnapshot(snapshot, {phase, translated = true, quiet = false, previousWrapperIds} = {}) {
  assert.equal(snapshot.owner.connected, true, `${phase}: source owner detached`);
  assert.equal(snapshot.owner.sourceHtml, snapshot.baselineHtml, `${phase}: source HTML changed`);
  assert.equal(snapshot.protectedIntact, true, `${phase}: protected source subtree changed`);
  assert.equal(snapshot.nestedWrappers, 0, `${phase}: nested translation wrappers`);
  assert.equal(snapshot.overflow, 0, `${phase}: mutation evidence overflowed`);
  const expected = translated ? 1 : 0;
  for (const [name, node, html] of [['source', snapshot.owner, snapshot.baselineHtml],
    ...snapshot.additions.map(node => [node.name, node, node.originalHtml])]) {
    assert.equal(node.connected, true, `${phase}/${name}: node detached`);
    assert.equal(node.sourceHtml, html, `${phase}/${name}: source structure changed`);
    assert.equal(node.protectedIntact, true, `${phase}/${name}: protected source subtree changed`);
    assert.equal(node.wrappers.length, expected, `${phase}/${name}: unexpected translation count`);
    assert.equal(node.allWrappers, expected, `${phase}/${name}: unexpected descendant translation count`);
    assert.equal(node.nested, 0, `${phase}/${name}: nested translation`);
    assert.equal(node.loadingCount, 0, `${phase}/${name}: pending or failed translation`);
    if (translated) assert.ok(node.wrappers.every(wrapper => wrapper.text.trim()), `${phase}/${name}: empty translation`);
    else assert.equal(node.artifactCount, 0, `${phase}/${name}: owned artifacts remain`);
  }
  if (!translated) {
    assert.equal(snapshot.totalWrappers, 0, `${phase}: page translation remains after restore`);
    assert.equal(snapshot.totalLoading, 0, `${phase}: page loading/retry remains after restore`);
  }
  if (quiet) assert.equal(snapshot.events.filter(event => event.addedWrappers || event.removedWrappers || event.insideTranslation
    || event.type === 'attributes' && event.insideArtifact).length,
    0, `${phase}: translation changed during a quiet observation`);
  if (previousWrapperIds) assert.deepEqual(snapshot.owner.wrappers.map(wrapper => wrapper.id), previousWrapperIds,
    `${phase}: completed wrapper identity changed`);
  return snapshot;
}

/** 第二轮完成后运行；成功结束时全文已停止且已移除测试追加内容。 */
async function runStabilityProbes({page, selector, timeout = 60000, artifactsDir, toggleFull, observeMs = 1200, syntheticRoute = false, checkFocus = () => {}}) {
  assert.equal(typeof toggleFull, 'function', 'toggleFull is required');
  assert.ok(Number.isFinite(observeMs) && observeMs >= 500 && observeMs <= 60000, 'observeMs must be between 500 and 60000');
  const key = `__fluentReadStability_${randomUUID().replaceAll('-', '')}`;
  const report = {ok: false, contractVersion: 2, scope: 'controlled-host-mutations-on-live-page', observeMs, steps: [],
    limits: ['Synthetic DOM/URL probes do not prove native infinite scroll, comments or SPA navigation.',
      'Stopped-session checks prove no DOM translation work for newly added content; they do not enumerate every internal listener or request.']};
  const persist = () => {if (artifactsDir) {
    fs.mkdirSync(artifactsDir, {recursive: true});
    fs.writeFileSync(path.join(artifactsDir, 'stability-probes.json'), JSON.stringify(report, null, 2));
  }};
  const command = (method, value) => {checkFocus(); return page.evaluate(({key, method, value}) => {
    if (!window[key]) throw new Error('Stability probe state is missing');
    return window[key][method](value);
  }, {key, method, value});};
  const waitTranslated = () => page.waitForFunction(key => {
    const state = window[key]?.snapshot();
    return state && [state.owner, ...state.additions].every(node => node.connected && node.wrappers.length === 1 &&
      node.wrappers[0].text.trim() && node.loadingCount === 0);
  }, key, {timeout});
  const waitRestored = () => page.waitForFunction(() =>
    !document.querySelector('.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper'), undefined, {timeout});
  const capture = async (name, options = {}) => {
    const snapshot = await command('snapshot');
    const step = {name, snapshot, ok: false}; report.steps.push(step); persist();
    assertStableSnapshot(snapshot, {phase: name, ...options}); step.ok = true; persist();
    if (artifactsDir) await page.screenshot({path: path.join(artifactsDir, `stability-${name}.png`), fullPage: false});
    return snapshot;
  };
  let installed = false;
  let routeChanged = false;
  let originalUrl;
  try {
    checkFocus(); report.initial = await page.evaluate(installStabilityProbeInPage, {key, selector}); installed = true;
    const initial = await command('snapshot');
    await command('reset'); await page.waitForTimeout(observeMs);
    await capture('quiet', {quiet: true, previousWrapperIds: initial.owner.wrappers.map(wrapper => wrapper.id)});
    report.sourceReplacement = await command('replaceSourceText');
    await waitTranslated(); await page.waitForTimeout(observeMs);
    await capture('same-text-replacement', {previousWrapperIds: initial.owner.wrappers.map(wrapper => wrapper.id)});
    report.artifactRemoval = await command('removeTranslation');
    await waitTranslated(); await page.waitForTimeout(observeMs);
    await capture('removed-wrapper-repaired');
    await command('reset'); await page.waitForTimeout(observeMs); await capture('repair-settled', {quiet: true});
    report.dynamicContent = await command('append', 'dynamic');
    await waitTranslated(); await capture('dynamic-append');
    if (syntheticRoute) {
      originalUrl = page.url();
      checkFocus(); await page.evaluate(() => {const url = new URL(location.href); url.searchParams.set('__fluentread_stability_probe', 'route'); history.pushState(history.state, '', url.href);});
      routeChanged = true;
      await page.waitForTimeout(observeMs);
      await command('append', 'synthetic-route'); await waitTranslated();
      await capture('synthetic-route-append');
      checkFocus(); await page.evaluate(url => history.replaceState(history.state, '', url), originalUrl); routeChanged = false;
    }
    await toggleFull(page); await waitRestored(); await capture('restore', {translated: false});
    await toggleFull(page); await waitTranslated(); await capture('retranslate');
    await toggleFull(page); await waitRestored();
    await command('append', 'stopped-session'); await command('reset'); await page.waitForTimeout(observeMs);
    await capture('stopped-session', {translated: false, quiet: true});
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (installed) report.failureSnapshot = await command('snapshot').catch(() => null);
    error.stabilityReport = report;
    throw error;
  } finally {
    let focusAllowed = true; try {checkFocus();} catch {focusAllowed = false; report.ok = false;}
    if (focusAllowed && routeChanged) await page.evaluate(url => history.replaceState(history.state, '', url), originalUrl).catch(error => {
      report.routeCleanupError = String(error); report.ok = false;
    });
    if (focusAllowed && installed) await Promise.resolve().then(() => command('dispose')).then(() => {report.probeResourcesReleased = true;}, error => {
      report.cleanupError = String(error); report.ok = false;
    });
    persist();
  }
  assert.equal(report.ok, true, 'Stability probe cleanup failed');
  return report;
}

/**
 * HN 真实控件合同来自公开 item?id=8863 与 hn.js 的 collstate：
 * tr.comtr.coll + .comment.noshow；必须通过可信 click 触发，绝不直接改 class。
 */
async function runNativeCommentToggle({page, timeout = 60000, artifactsDir, observeMs = 600, checkFocus = () => {}}) {
  const key = `__fluentReadNativeComment_${randomUUID().replaceAll('-', '')}`;
  const report = {ok: false, scope: 'native-hacker-news-comment-collapse-expand', steps: []};
  const persist = () => {if (artifactsDir) {
    fs.mkdirSync(artifactsDir, {recursive: true});
    fs.writeFileSync(path.join(artifactsDir, 'native-comment-toggle.json'), JSON.stringify(report, null, 2));
  }};
  let installed = false;
  let trigger;
  try {
    report.initial = await page.evaluate(key => {
      if (location.hostname !== 'news.ycombinator.com') throw new Error('Native comment probe requires Hacker News');
      const wrapper = '.fluent-read-bilingual-content';
      const row = [...document.querySelectorAll('tr.comtr:not(.coll)')].find(row =>
        row.id && row.querySelector('a.togg.clicky') && row.querySelector('.comment > .commtext')?.querySelector(wrapper));
      if (!row) throw new Error('No expanded translated HN comment with native toggle is available');
      const control = row.querySelector('a.togg.clicky');
      const comment = row.querySelector('.comment');
      const content = row.querySelector('.comment > .commtext');
      const sourceHtml = () => {
        const clone = content.cloneNode(true);
        clone.querySelectorAll('.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper,[data-fr-translation-owned="true"]').forEach(node => node.remove());
        clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach(node => node.replaceWith(...node.childNodes));
        return clone.innerHTML;
      };
      const clicks = [];
      const onClick = event => {if (control === event.target || control.contains(event.target)) clicks.push({trusted: event.isTrusted});};
      document.addEventListener('click', onClick, true);
      const snapshot = () => {
        const results = [...content.querySelectorAll(wrapper)];
        const parents = results.map(node => node.parentElement);
        return {connected: row.isConnected && content.isConnected, collapsed: row.classList.contains('coll'),
          hiddenClass: comment.classList.contains('noshow'), display: getComputedStyle(comment).display,
          sourceHtml: sourceHtml(), wrapperCount: results.length, nonempty: results.every(node => node.textContent.trim()),
          duplicateParents: parents.length - new Set(parents).size,
          nested: content.querySelectorAll(`${wrapper} ${wrapper}`).length,
          pending: content.querySelectorAll('.fluent-read-loading,.fluent-read-retry-wrapper').length,
          controlText: control.textContent, clicks: [...clicks]};
      };
      window[key] = {row, snapshot, dispose: () => {document.removeEventListener('click', onClick, true); delete window[key];}};
      return {rowId: row.id, triggerSelector: `tr.comtr[id="${CSS.escape(row.id)}"] a.togg.clicky`, baseline: snapshot()};
    }, key);
    installed = true;
    trigger = page.locator(report.initial.triggerSelector);
    checkFocus(); await trigger.scrollIntoViewIfNeeded({timeout});
    checkFocus(); await trigger.click({timeout});
    await page.waitForFunction(key => {
      const current = window[key].snapshot(); return current.collapsed && current.hiddenClass && current.display === 'none';
    }, key, {timeout});
    const collapsed = await page.evaluate(key => window[key].snapshot(), key);
    report.steps.push({name: 'collapsed', snapshot: collapsed}); persist();
    assert.equal(collapsed.connected, true, 'HN collapse removed the original comment');
    assert.equal(collapsed.sourceHtml, report.initial.baseline.sourceHtml, 'HN collapse altered comment source');
    assert.equal(collapsed.clicks.length, 1, 'HN collapse did not receive exactly one click');
    assert.equal(collapsed.clicks[0].trusted, true, 'HN collapse was not a trusted click');
    if (artifactsDir) await page.screenshot({path: path.join(artifactsDir, 'native-comment-collapsed.png'), fullPage: false});
    checkFocus(); await trigger.click({timeout});
    await page.waitForFunction(({key, expected}) => {
      const current = window[key].snapshot();
      return !current.collapsed && !current.hiddenClass && current.display !== 'none' && current.wrapperCount === expected && !current.pending;
    }, {key, expected: report.initial.baseline.wrapperCount}, {timeout});
    await page.waitForTimeout(observeMs);
    const expanded = await page.evaluate(key => window[key].snapshot(), key);
    report.steps.push({name: 'expanded', snapshot: expanded}); persist();
    assert.equal(expanded.connected, true, 'HN expand lost the original comment');
    assert.equal(expanded.sourceHtml, report.initial.baseline.sourceHtml, 'HN expand altered comment source');
    assert.equal(expanded.wrapperCount, report.initial.baseline.wrapperCount, 'HN expand lost translated paragraphs');
    assert.equal(expanded.nonempty, true, 'HN expand left empty translation');
    assert.equal(expanded.duplicateParents, 0, 'HN expand duplicated translation owners');
    assert.equal(expanded.nested, 0, 'HN expand nested translation');
    assert.equal(expanded.pending, 0, 'HN expand left pending/error artifacts');
    assert.equal(expanded.clicks.length, 2, 'HN collapse/expand did not receive exactly two clicks');
    assert.ok(expanded.clicks.every(click => click.trusted), 'HN expand was not a trusted click');
    assert.equal(expanded.controlText, report.initial.baseline.controlText, 'HN toggle label did not restore');
    if (artifactsDir) await page.screenshot({path: path.join(artifactsDir, 'native-comment-expanded.png'), fullPage: false});
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); error.nativeCommentReport = report; throw error;
  } finally {
    let focusAllowed = true; try {checkFocus();} catch {focusAllowed = false; report.ok = false;}
    if (focusAllowed && installed) {
      const collapsed = await page.evaluate(key => window[key]?.snapshot().collapsed, key).catch(() => false);
      if (collapsed) await Promise.resolve().then(() => {checkFocus(); return trigger.click({timeout});}).catch(error => {report.restoreError = String(error); report.ok = false;});
      await Promise.resolve().then(() => {checkFocus(); return page.evaluate(key => window[key]?.dispose(), key);}).then(() => {report.probeResourcesReleased = true;}, error => {
        report.cleanupError = String(error); report.ok = false;
      });
    }
    persist();
  }
  assert.equal(report.ok, true, 'HN native comment probe cleanup failed');
  return report;
}

module.exports = {installStabilityProbeInPage, assertStableSnapshot, runStabilityProbes, runNativeCommentToggle};
