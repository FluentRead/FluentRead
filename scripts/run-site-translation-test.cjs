#!/usr/bin/env node

// 运行真实网站的悬浮翻译或全文翻译回归。
//
// 这个脚本只创建临时 Edge profile，并使用第二屏不抢焦点的正常窗口；它不会连接用户日常
// 浏览器，也不会通过 page.evaluate 派发伪造的键盘事件。Control 和 Alt+T
// 都由 Playwright keyboard API 发送真实的浏览器按键。

const {guardBrowserClose, getGuardedBrowserPid} = require('./testing/owned-browser-close.cjs');
const {createSiteFocusGuard} = require('./testing/site-focus-guard.cjs');
const {installControlledProvider} = require('./site-translation/controlled-provider.cjs');
const {interactionHrefsEquivalent} = require('./site-translation/interaction-url.cjs');
const {runStabilityProbes, runNativeCommentToggle} = require('./site-translation/stability-probes.cjs');
const {FACEBOOK_PUBLIC_POST_SELECTORS, prepareFacebookPublicPost, isVerifiedFacebookPublicPostPreparation} =
  require('./site-translation/facebook-public-post-preparation.cjs');
const {reportErrorCodes, siteTestExitCode} = require('./testing/site-error-diagnostics.cjs');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {
  CASES,
  collectBaseCaseConfigErrors,
  normalizeCaseConfig,
  normalizeDismissiblePromotion,
} = require('./site-translation/case-config.cjs');

const PRODUCTION_SOURCE_ROOTS = ['src', 'entrypoints', 'components', 'public', 'styles'];
const PRODUCTION_CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'wxt.config.ts', 'tsconfig.json'];
const INTERACTION_CLOSE_ATTEMPT_TIMEOUT = 1500;
// 仅本进程从当前 tracker 读取的覆盖快照可以携带 unchanged credit；历史 JSON/裸计数不认证。
const trustedCoverageSnapshots = new WeakMap();
const ownedCompletionReaders = new WeakSet();
const ownerCompletionLedgers = new WeakMap();
const trustedCompletionStatuses = new WeakMap();
// Exact LearnOpenGL baseline/page handles only; context teardown destroys their DOM references.
const protectedNavContractHandles = new WeakMap();
// 仅成功的原生准备可以绑定本页原始帖子 dialog；选择器近似或后续替换的 dialog 不继承豁免。
const facebookReadingDialogs = new WeakMap();
const pageFocusGuards = new WeakMap();
function assertPageFocusAllowed(page) {pageFocusGuards.get(page)?.check();}
const SINGLE_TOKEN_TECHNICAL_WORDS = new Set([
  'accept', 'api', 'authorization', 'cookie', 'css', 'etag', 'host', 'html', 'http', 'https', 'json',
  'referer', 'referrer', 'sql', 'tcp', 'tls', 'udp', 'uri', 'url', 'user-agent', 'xml',
]);

function isNaturalLanguageText(value) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (/^https?:\/\/\S+$/iu.test(text)) return false;
  if (!text || /^#!|^#lang\b|^<!doctype\b|^<\?xml\b/iu.test(text)) return false;
  if (/^[a-z][a-z0-9_-]*(?:-stmt|-expr|-clause)?:\s*(?:hide|show|expand|collapse|藏起来)?$/iu.test(text)) {
    return false;
  }
  const token = text.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/gu, '');
  if (!/\s/u.test(token)) {
    if (SINGLE_TOKEN_TECHNICAL_WORDS.has(token.toLowerCase())) return false;
    if (/^[A-Z][A-Z0-9_-]{3,15}$/u.test(token) && !/[AEIOU]/u.test(token)) return false;
  }
  const letters = text.match(/[A-Za-z]/gu)?.length || 0;
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
  return letters >= 2 && letters >= cjk;
}

function newestFile(paths, stat = fs.statSync, readDirectory = fs.readdirSync) {
  let latest = null;
  const visit = (candidatePath) => {
    let info;
    try {
      info = stat(candidatePath);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readDirectory(candidatePath)) visit(path.join(candidatePath, entry));
      return;
    }
    if (!info.isFile()) return;
    if (!latest || info.mtimeMs > latest.mtimeMs) latest = {path: candidatePath, mtimeMs: info.mtimeMs};
  };
  for (const candidatePath of paths) visit(candidatePath);
  return latest;
}

function evaluateProductionBuildFreshness({extensionDir, manifestMtimeMs, latestSource}) {
  const outputName = path.basename(path.resolve(extensionDir));
  const production = outputName === 'chrome-mv3' || outputName === 'firefox-mv2';
  if (!production || !latestSource) return {ok: true, production, latestSource};
  return {
    ok: manifestMtimeMs >= latestSource.mtimeMs,
    production,
    latestSource,
    manifestMtimeMs,
  };
}

function assertFreshProductionExtension(extensionDir, projectRoot = path.join(__dirname, '..')) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const latestSource = newestFile([
    ...PRODUCTION_SOURCE_ROOTS.map((name) => path.join(projectRoot, name)),
    ...PRODUCTION_CONFIG_FILES.map((name) => path.join(projectRoot, name)),
  ]);
  const state = evaluateProductionBuildFreshness({
    extensionDir,
    manifestMtimeMs: fs.statSync(manifestPath).mtimeMs,
    latestSource,
  });
  if (!state.ok) {
    throw new Error(
      `拒绝测试旧 production extension：manifest ${manifestPath} 的时间 ` +
      `${new Date(state.manifestMtimeMs).toISOString()} 早于最新生产源文件 ${state.latestSource.path} ` +
      `(${new Date(state.latestSource.mtimeMs).toISOString()})，请先重新构建`,
    );
  }
  return state;
}

function reportProgress(message) {
  process.stderr.write(`[site-translation-test] ${message}\n`);
}

function parseArgs(argv) {
  const args = {
    focusSafeHelper: path.join(__dirname, 'testing/focus-safe-browser.cjs'),
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    background: true,
    allowNetwork: false,
    timeout: 60000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--background') continue;
    if (token === '--headed') {
      args.background = false;
      continue;
    }
    if (['--controlled-provider', '--stability-probes'].includes(token)) {
      args[token === '--controlled-provider' ? 'controlledProvider' : 'stabilityProbes'] = true;
      continue;
    }
    if (token === '--allow-network') {
      args.allowNetwork = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值：${token}`);
    args[key] = value;
    index += 1;
  }

  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('--timeout 必须为正数');
  if (args.stabilityProbes && args.mode !== 'full') throw new Error('--stability-probes requires --mode full');
  if (!args.case) throw new Error('必须传入 --case，例如 example-com');
  if (!CASES[args.case]) throw new Error(`未知 case：${args.case}`);
  if (!['hover', 'full'].includes(args.mode)) throw new Error('--mode 必须是 hover 或 full');
  if (!args.extensionDir) throw new Error('必须传入 --extension-dir');
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root');
  if (!args.allowNetwork) throw new Error('真实网络站点测试必须显式传入 --allow-network');
  if (!args.runtimeDiagnosticsHelper) throw new Error('必须传入 --runtime-diagnostics-helper；缺少运行时采集不能判定站点兼容性通过');
  if (args.background && !args.focusSafeHelper) {
    throw new Error('后台模式必须传入 --focus-safe-helper，禁止回退到会抢焦点的 Playwright 启动');
  }

  const caseConfig = CASES[args.case];
  const normalized = normalizeCaseConfig(args.case, caseConfig);
  const configErrors = collectBaseCaseConfigErrors(args.case, caseConfig, normalized);
  if (configErrors.length > 0) {
    throw new Error(`case ${args.case} 配置无效：\n- ${configErrors.join('\n- ')}`);
  }
  if (!normalized.modes.includes(args.mode)) throw new Error(`case ${args.case} 不支持 ${args.mode} 模式`);
  if (!args.controlledProvider && (normalized.coverageRules.some(rule => rule.sourcePartition) ||
      normalized.hoverTargets.some(target => target.sourcePartition))) {
    throw new Error(`case ${args.case} 的 sourcePartition 完整正文契约必须使用 --controlled-provider；不能跳过完整来源验收`);
  }

  return {
    ...caseConfig,
    ...args,
    ...normalized,
    ...(args.controlledProvider ? {service: 'microsoft'} : {}),
  };
}

function loadRuntimeDiagnostics(helperPath, load = require) {
  const {createRuntimeDiagnostics, redact} = load(path.resolve(helperPath));
  if (typeof createRuntimeDiagnostics !== 'function' || typeof redact !== 'function') {
    throw new Error('运行时诊断 helper 缺少 createRuntimeDiagnostics/redact 接口');
  }
  const diagnostics = createRuntimeDiagnostics();
  for (const name of ['start', 'attachPage', 'setExtensionId', 'setPhase', 'flush', 'snapshot', 'assertClean', 'stop']) {
    if (typeof diagnostics?.[name] !== 'function') throw new Error(`运行时诊断 helper 缺少接口：${name}`);
  }
  return {diagnostics, redact};
}

// 原始功能失败与诊断失败分别保留。即使 verdict/write/stop 失败，调用方仍须清理自有浏览器。
async function finishRuntimeDiagnostics(diagnostics, output, artifactsDir) {
  const failures = [];
  let verdictPassed = false;
  const attempt = async (stage, action) => {
    try {await action();} catch (error) {failures.push({stage, error}); output.ok = false;}
  };
  await attempt('runtime-flush', () => diagnostics.flush());
  await attempt('runtime-verdict', () => {diagnostics.assertClean(); verdictPassed = true;});
  await attempt('runtime-snapshot', () => {
    output.runtimeDiagnostics = diagnostics.snapshot();
    if (verdictPassed && output.runtimeDiagnostics?.passed !== true) throw new Error('运行时诊断缺少通过证据');
  });
  if (artifactsDir && output.runtimeDiagnostics) await attempt('runtime-evidence', () =>
    fs.writeFileSync(path.join(artifactsDir, 'runtime-diagnostics.json'), JSON.stringify(output.runtimeDiagnostics, null, 2)));
  await attempt('runtime-stop', () => diagnostics.stop());
  // primaryError 的异常身份由 main 保留；这里返回全部失败，不能覆盖它或让清理提前退出。
  return failures;
}

async function unloadRuntimePage(page, diagnostics, phase) {
  if (!page || page.isClosed()) return {status: 'unavailable', reason: 'page-already-closed-or-not-created'};
  diagnostics.setPhase(phase);
  await page.goto('about:blank', {waitUntil: 'domcontentloaded', timeout: 3000});
  return {status: 'observed', action: 'about:blank-navigation', timeoutMs: 3000};
}

function assertCoverageReport(rules, report, phase) {
  const errors = [];
  const byName = new Map((report || []).map((item) => [item.name, item]));
  for (const rule of rules) {
    const state = byName.get(rule.name);
    if (!state) {
      errors.push(`${rule.name} 缺少覆盖报告`);
      continue;
    }
    if (state.seenCount < rule.minSeen) {
      errors.push(`${rule.name} 仅发现 ${state.seenCount}/${rule.minSeen} 个可译节点`);
    }
    const unchanged = state.verifiedUnchangedCount ?? 0;
    const completed = state.completedCount ?? state.translatedCount;
    const snapshot = trustedCoverageSnapshots.get(report);
    const trusted = snapshot?.counts.get(rule.name);
    const verified = unchanged === 0 || (trusted &&
      snapshot.ledger && ownerCompletionLedgers.get(snapshot.page) === snapshot.ledger &&
      ['translatedCount', 'verifiedUnchangedCount', 'completedCount', 'completionSessionId', 'completionPass']
        .every((field) => trusted[field] === state[field]) &&
      Number.isSafeInteger(state.completionSessionId) && state.completionSessionId > 0 &&
      Number.isSafeInteger(state.completionPass) && state.completionPass > 0);
    if (!verified || ![state.translatedCount, unchanged, completed].every((count) => Number.isSafeInteger(count) && count >= 0) ||
        completed !== state.translatedCount + unchanged || completed !== state.seenCount) {
      errors.push(`${rule.name} 仅翻译 ${state.translatedCount}/${state.seenCount} 个节点，` +
        `已验证相同 ${unchanged}，完成 ${completed}/${state.seenCount}` +
        (state.missedSamples?.length ? `，漏译：${JSON.stringify(state.missedSamples)}` : ''));
    }
    for (const expectedText of rule.sourceIncludes) {
      const matched = Array.isArray(state.matchedSourceIncludes)
        ? state.matchedSourceIncludes.includes(expectedText)
        : (state.sourceSamples || []).some((sourceText) => sourceText.includes(expectedText));
      if (!matched) {
        errors.push(`${rule.name} 未命中预期原文：${expectedText}`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`${phase} 全文覆盖断言失败：${errors.join('；')}`);
  return report;
}

function assertCoverageRestoration(report, phase) {
  const errors = [];
  for (const state of report || []) {
    if (state.ownedCount > 0) errors.push(`${state.name} 仍有 ${state.ownedCount} 个扩展节点`);
    if (state.changedCount > 0) {
      errors.push(`${state.name} 有 ${state.changedCount} 个节点未恢复：${JSON.stringify(state.changedSamples || [])}`);
    }
    if (state.missingStaticCount > 0) {
      errors.push(`${state.name} 丢失 ${state.missingStaticCount} 个静态基线节点`);
    }
  }
  if (errors.length > 0) throw new Error(`${phase} 覆盖区域恢复断言失败：${errors.join('；')}`);
  return report;
}

function withMandatoryHeadingCoverage(rules, protectPageHeading = false, fullPageScope = 'finite-page') {
  // 站点自身的列表页标题属于应用 UI，显式纳入 forbidden contract 时保留原文。
  if (protectPageHeading) return [...rules];
  return [
    ...rules,
    {
      name: 'mandatory-visible-latin-h1',
      selector: 'h1',
      kind: 'heading',
      minInitial: 0,
      minSeen: 0,
      trackDynamic: fullPageScope !== 'initial-corpus',
      sourceIncludes: [],
      requiresPhrase: true,
    },
  ];
}

const COVERAGE_TRACKER_KEY = '__fluentReadSiteCoverageTrackerV1';
const COVERAGE_EXCLUDED_SELECTOR_LIST = [
  '[hidden]',
  '[aria-hidden="true"]',
  '[inert]',
  '[translate="no"]',
  '.notranslate',
  '.sr-only',
  '.visually-hidden',
  'script',
  'style',
  'pre',
  'code',
  '.MathJax_Display',
  '.MathJax_Preview',
  '.MathJax',
  'mjx-container',
  '.katex',
  'dialog',
  '[role="dialog"]',
  '[contenteditable]:not([contenteditable="false"])',
];
const COVERAGE_EXCLUDED_ANCESTORS = COVERAGE_EXCLUDED_SELECTOR_LIST.join(', ');
const COVERAGE_PROTECTED_DESCENDANTS = [...COVERAGE_EXCLUDED_SELECTOR_LIST, 'math', 'svg'].join(', ');
const COVERAGE_NON_DIALOG_EXCLUSIONS = COVERAGE_EXCLUDED_SELECTOR_LIST
  .filter(selector => selector !== 'dialog' && selector !== '[role="dialog"]');

function coverageEligibilityContext(page) {
  return {
    excludedSelector: COVERAGE_EXCLUDED_ANCESTORS,
    protectedSelector: COVERAGE_PROTECTED_DESCENDANTS,
    nonDialogExcludedSelector: COVERAGE_NON_DIALOG_EXCLUSIONS.join(', '),
    nonDialogProtectedSelector: [...COVERAGE_NON_DIALOG_EXCLUSIONS, 'math', 'svg'].join(', '),
    readingPostDialog: facebookReadingDialogs.get(page),
  };
}

async function authorizeFacebookReadingDialog(page, preparation) {
  if (!isVerifiedFacebookPublicPostPreparation(preparation, page)) {
    throw new Error('Facebook reading scope requires a successful native preparation');
  }
  if (facebookReadingDialogs.has(page)) throw new Error('Facebook reading scope is already bound');
  const readingPostDialog = await page.evaluateHandle(({expectedUrl, selectors}) => {
    const messages = [...document.querySelectorAll(selectors.message)];
    const dialogs = [...document.querySelectorAll(selectors.readingDialog)];
    const canonicals = [...document.querySelectorAll('link[rel="canonical"][href]')];
    const message = messages[0], dialog = dialogs[0];
    const article = message?.closest(selectors.publicArticle);
    if (location.href !== expectedUrl || messages.length !== 1 || dialogs.length !== 1 ||
        message.closest('[role="dialog"]') !== dialog || article?.closest('[role="dialog"]') !== dialog ||
        canonicals.length !== 1 || new URL(canonicals[0].getAttribute('href'), location.href).href !== expectedUrl ||
        dialog.closest('[hidden],[inert],[aria-hidden="true"]')) {
      throw new Error('Facebook reading scope changed after native preparation');
    }
    return dialog;
  }, {expectedUrl: preparation.url, selectors: FACEBOOK_PUBLIC_POST_SELECTORS});
  if (!readingPostDialog.asElement()) {
    await readingPostDialog.dispose();
    throw new Error('Facebook reading scope has no native dialog identity');
  }
  facebookReadingDialogs.set(page, readingPostDialog);
}

async function releaseFacebookReadingDialog(page) {
  const handle = facebookReadingDialogs.get(page);
  facebookReadingDialogs.delete(page);
  await handle?.dispose();
}

// Predicate and failure details share exactly the same eligibility decisions.
function readCoverageReadinessInPage({coverageRules, excludedSelector, protectedSelector,
  nonDialogExcludedSelector, readingPostDialog, technicalWords, diagnostics = false}) {
  // 只浅复制 Document 壳；在无窗口文档中 import，避免只读探针重新请求来源图片。
  const snapshotDocument = document.cloneNode(false);
  const excludedAncestor = node => {
    let ancestor = node.closest(excludedSelector);
    while (ancestor && ancestor === readingPostDialog && !ancestor.matches(nonDialogExcludedSelector)) {
      ancestor = ancestor.parentElement?.closest(excludedSelector) || null;
    }
    return ancestor;
  };
  const technicalWordSet = new Set(technicalWords);
  const naturalLanguage = value => {
    const text = String(value || '').replace(/\s+/gu, ' ').trim();
    if (/^https?:\/\/\S+$/iu.test(text)) return false;
    if (!text || /^#!|^#lang\b|^<!doctype\b|^<\?xml\b/iu.test(text)) return false;
    if (/^[a-z][a-z0-9_-]*(?:-stmt|-expr|-clause)?:\s*(?:hide|show|expand|collapse|藏起来)?$/iu.test(text)) return false;
    const token = text.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/gu, '');
    if (!/\s/u.test(token) && (technicalWordSet.has(token.toLowerCase()) ||
      (/^[A-Z][A-Z0-9_-]{3,15}$/u.test(token) && !/[AEIOU]/u.test(token)))) return false;
    const letters = text.match(/[A-Za-z]/gu)?.length || 0;
    const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
    return letters >= 2 && letters >= cjk;
  };
  const sourceText = node => {
    const clone = snapshotDocument.importNode(node, true);
    clone.querySelectorAll('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, [data-fr-translation-owned="true"]')
      .forEach(owned => owned.remove());
    clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach(segment => segment.replaceWith(...segment.childNodes));
    clone.querySelectorAll(protectedSelector).forEach(protectedNode => protectedNode.remove());
    return (clone.textContent || '').replace(/\s+/gu, ' ').trim();
  };
  const rows = coverageRules.map(rule => {
    const nodes = [...document.querySelectorAll(rule.selector)].map((node, index) => {
      const text = sourceText(node), reasons = [];
      const isHtml = node instanceof HTMLElement;
      const excluded = excludedAncestor(node);
      const outsideReadingScope = readingPostDialog && (!readingPostDialog.isConnected ||
        !readingPostDialog.matches('[role="dialog"][aria-modal="true"]') || !readingPostDialog.contains(node));
      const artifact = node.closest('.fluent-read-bilingual-content, [data-fr-translation-owned="true"]');
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (!isHtml) reasons.push('not-html-element');
      if (excluded) reasons.push('excluded-ancestor');
      if (outsideReadingScope) reasons.push('unverified-reading-scope');
      if (artifact) reasons.push('translation-artifact');
      if (!(rect.width > 0 && rect.height > 0)) reasons.push('no-rect');
      if (style.display === 'none' || style.visibility === 'hidden') reasons.push('hidden-style');
      if (!text) reasons.push('protected-source-empty');
      if (!naturalLanguage(text)) reasons.push('natural-language-false');
      if (text.length < (rule.minTextLength || 0)) reasons.push('min-text-length');
      if (rule.requiresPhrase && !/[\s.,:;!?()\-]/u.test(text)) reasons.push('requires-phrase');
      return {index, tag: node.localName, id: node.id, text, sourceLength: text.length, reasons,
        excludedAncestor: excluded ? {tag: excluded.localName, id: excluded.id, classes: excluded.className} : null,
        rect: {width: rect.width, height: rect.height}, style: {display: style.display, visibility: style.visibility},
        rawSample: (node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 180)};
    });
    const eligible = nodes.filter(node => node.reasons.length === 0);
    const missingSourceIncludes = rule.sourceIncludes.filter(fragment => !eligible.some(node => node.text.includes(fragment)));
    return {name: rule.name, selector: rule.selector, nodes, eligible, missingSourceIncludes,
      minInitial: rule.minInitial, ready: eligible.length >= rule.minInitial && missingSourceIncludes.length === 0};
  });
  if (!diagnostics) return rows.every(row => row.ready);
  return rows.map(row => ({name: row.name, selector: row.selector, count: row.nodes.length,
    samples: row.nodes.slice(0, 8).map(node => node.rawSample), eligibleCount: row.eligible.length,
    minInitial: row.minInitial, ready: row.ready, missingSourceIncludes: row.missingSourceIncludes,
    ruleRejections: [...(row.eligible.length < row.minInitial ? ['minimum-eligible-count'] : []),
      ...(row.missingSourceIncludes.length ? ['source-fragment-missing'] : [])],
    eligibleSamples: row.eligible.slice(0, 8).map(node => ({index: node.index, source: node.text.slice(0, 180)})),
    rejected: row.nodes.filter(node => node.reasons.length).map(({text, ...node}) => ({...node, sourceSample: text.slice(0, 180)}))}));
}

async function waitForCoverageReady(page, rules, timeout) {
  const argument = {coverageRules: rules, ...coverageEligibilityContext(page),
    technicalWords: [...SINGLE_TOKEN_TECHNICAL_WORDS]};
  try {
    await page.waitForFunction(readCoverageReadinessInPage, argument, {timeout});
  } catch (error) {
    let diagnostics;
    try {diagnostics = await page.evaluate(readCoverageReadinessInPage, {...argument, diagnostics: true});}
    catch (diagnosticError) {diagnostics = {status: 'unavailable', reason: diagnosticError.message};}
    const failure = new Error(`${error.message}\ncoverageRules 页面就绪诊断：${JSON.stringify(diagnostics)}`, {cause: error});
    failure.readinessDiagnostic = diagnostics;
    throw failure;
  }
}

async function installCoverageTracker(page, rules) {
  await page.evaluate(({coverageRules, trackerKey, excludedSelector, protectedSelector,
    nonDialogExcludedSelector, nonDialogProtectedSelector, readingPostDialog, technicalWords}) => {
    window[trackerKey]?.stop?.();
    const snapshotDocument = document.cloneNode(false);
    const ownedSelector = [
      '.fluent-read-bilingual-content',
      '.fluent-read-loading',
      '.fluent-read-retry-wrapper',
      '[data-fr-translation-owned="true"]',
    ].join(', ');
    const artifactSelector = `${ownedSelector}, [data-fr-translation-segment="true"]`;
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const guardedAncestor = (node, selector, nonDialogSelector) => {
      let ancestor = node.closest(selector);
      while (ancestor && ancestor === readingPostDialog && !ancestor.matches(nonDialogSelector)) {
        ancestor = ancestor.parentElement?.closest(selector) || null;
      }
      return ancestor;
    };
    const technicalWordSet = new Set(technicalWords);
    const naturalLanguage = (text) => {
      if (/^https?:\/\/\S+$/iu.test(text)) return false;
      if (!text || /^#!|^#lang\b|^<!doctype\b|^<\?xml\b/iu.test(text)) return false;
      if (/^[a-z][a-z0-9_-]*(?:-stmt|-expr|-clause)?:\s*(?:hide|show|expand|collapse|藏起来)?$/iu.test(text)) {
        return false;
      }
      const token = text.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/gu, '');
      if (!/\s/u.test(token) && (technicalWordSet.has(token.toLowerCase()) ||
        (/^[A-Z][A-Z0-9_-]{3,15}$/u.test(token) && !/[AEIOU]/u.test(token)))) return false;
      const letters = text.match(/[A-Za-z]/gu)?.length || 0;
      const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
      return letters >= 2 && letters >= cjk;
    };
    const metrics = {
      canonicalSnapshotCalls: 0,
      structureSignatureCalls: 0,
      initialStructureSignatureCalls: 0,
      dynamicStructureSignatureCalls: 0,
      restorationStructureSignatureCalls: 0,
      artifactMutationCount: 0,
      ignoredProtectedMutationCount: 0,
      hostMutationCount: 0,
      cheapRefreshCount: 0,
    };
    const canonicalSnapshot = (node, structurePhase) => {
      metrics.canonicalSnapshotCalls += 1;
      const clone = snapshotDocument.importNode(node, true);
      clone.querySelectorAll(ownedSelector).forEach((owned) => owned.remove());
      clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => {
        segment.replaceWith(...segment.childNodes);
      });
      clone.querySelectorAll(protectedSelector).forEach((protectedNode) => protectedNode.remove());
      const sourceText = normalizeText(clone.textContent);
      if (!structurePhase) return {sourceText, structure: ''};
      metrics.structureSignatureCalls += 1;
      metrics[`${structurePhase}StructureSignatureCalls`] += 1;
      const visit = (current) => {
        if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.nodeValue) ? '#text' : null;
        if (current.nodeType !== Node.ELEMENT_NODE) return null;
        const children = [];
        for (const child of current.childNodes) {
          const signature = visit(child);
          if (!signature || (signature === '#text' && children[children.length - 1] === '#text')) continue;
          children.push(signature);
        }
        return [
          current.tagName.toLowerCase(),
          children,
        ];
      };
      return {sourceText, structure: JSON.stringify(visit(clone))};
    };
    const isEligible = (node, rule, text) => {
      if (!(node instanceof HTMLElement) || guardedAncestor(node, excludedSelector, nonDialogExcludedSelector)) return false;
      if (readingPostDialog && (!readingPostDialog.isConnected ||
          !readingPostDialog.matches('[role="dialog"][aria-modal="true"]') || !readingPostDialog.contains(node))) return false;
      if (node.closest(ownedSelector)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
        naturalLanguage(text) && text.length >= (rule.minTextLength || 0) &&
        (!rule.requiresPhrase || /[\s.,:;!?()\-]/u.test(text));
    };
    const ownedByRuleNode = (owned, node, selector) => {
      try {
        return owned.closest(selector) === node;
      } catch {
        return false;
      }
    };
    const translationWrapper = (node, selector) => [...node.querySelectorAll('.fluent-read-bilingual-content')]
      .find((wrapper) => ownedByRuleNode(wrapper, node, selector) &&
        /[\u3400-\u9fff]/u.test(wrapper.textContent || '')) || null;
    const states = coverageRules.map((rule, ruleIndex) => ({
      rule,
      ruleIndex,
      recordsById: new Map(),
      recordsByNode: new WeakMap(),
      recordsByIdentity: new Map(),
      nextRecordId: 0,
    }));
    const identityFor = (node, sourceText) => {
      const href = node instanceof HTMLAnchorElement ? node.href : node.querySelector('a[href]')?.href || '';
      return `${node.tagName}\n${href}\n${sourceText}`;
    };
    const removeIdentity = (state, record) => {
      const bucket = state.recordsByIdentity.get(record.identity);
      bucket?.delete(record);
      if (bucket?.size === 0) state.recordsByIdentity.delete(record.identity);
    };
    const addIdentity = (state, record) => {
      const bucket = state.recordsByIdentity.get(record.identity) || new Set();
      bucket.add(record);
      state.recordsByIdentity.set(record.identity, bucket);
    };
    const refreshTranslated = (state, record) => {
      if (!record.node?.isConnected) return;
      const wrapper = translationWrapper(record.node, state.rule.selector);
      if (!wrapper) return;
      // 宿主页 generation 变化时，旧 wrapper 仍可能保持挂载。旧 wrapper 身份绝不能
      // 为新原文背书；真正的新扩展 wrapper 只把当前 generation 提升一次。
      if (record.translatedWrapper === wrapper && record.translatedGeneration !== record.generation) return;
      record.translatedWrapper = wrapper;
      record.translatedGeneration = record.generation;
      record.translatedEver = true;
    };
    const recordCurrentlyTranslated = (state, record) => Boolean(
      record.node?.isConnected &&
      record.translatedGeneration === record.generation &&
      record.translatedWrapper === translationWrapper(record.node, state.rule.selector),
    );
    const detachRecord = (state, record, node) => {
      state.recordsByNode.delete(node);
      if (record.node === node) {
        record.node = null;
        record.generation += 1;
      }
    };
    const attachRecord = (state, node, snapshot, phase, afterStart) => {
      const identity = identityFor(node, snapshot.sourceText);
      let record = state.recordsByNode.get(node);
      if (record && phase === 'dynamic' &&
          (record.identity !== identity || record.initialStructure !== snapshot.structure)) {
        removeIdentity(state, record);
        record.identity = identity;
        record.sourceText = snapshot.sourceText;
        record.initialStructure = snapshot.structure;
        record.translatedEver = false;
        record.firstSeenAfterStart = true;
        record.generation += 1;
        addIdentity(state, record);
      }
      if (!record && phase === 'dynamic') {
        record = [...(state.recordsByIdentity.get(identity) || [])]
          .find((candidate) => !candidate.node?.isConnected);
      }
      if (!record) {
        const recordId = state.nextRecordId++;
        record = {
          recordId,
          identity,
          node,
          sourceText: snapshot.sourceText,
          initialStructure: snapshot.structure,
          translatedEver: false,
          translatedWrapper: null,
          translatedGeneration: -1,
          firstSeenAfterStart: afterStart,
          generation: 0,
        };
        state.recordsById.set(recordId, record);
        addIdentity(state, record);
      }
      if (record.node && record.node !== node) record.generation += 1;
      record.node = node;
      state.recordsByNode.set(node, record);
      refreshTranslated(state, record);
      return record;
    };
    const initialScan = () => {
      for (const state of states) {
        for (const node of document.querySelectorAll(state.rule.selector)) {
          if (!(node instanceof HTMLElement) || guardedAncestor(node, excludedSelector, nonDialogExcludedSelector) || node.closest(ownedSelector)) continue;
          const snapshot = canonicalSnapshot(node, 'initial');
          if (isEligible(node, state.rule, snapshot.sourceText)) attachRecord(state, node, snapshot, 'initial', false);
        }
      }
    };
    const cheapRefresh = () => {
      metrics.cheapRefreshCount += 1;
      for (const state of states) for (const record of state.recordsById.values()) refreshTranslated(state, record);
    };
    const elementFor = (node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const isWithin = (node, selector) => {
      const element = elementFor(node);
      if (selector === protectedSelector) {
        return Boolean(element && guardedAncestor(element, protectedSelector, nonDialogProtectedSelector));
      }
      return Boolean(element && (element.matches?.(selector) || element.closest?.(selector)));
    };
    const isArtifactOnlyMutation = (mutation) => {
      if (isWithin(mutation.target, artifactSelector)) return true;
      if (mutation.type !== 'childList') return false;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      // 一次 React commit 可能在同一 MutationRecord 中移除扩展 wrapper 并挂载新的宿主正文。
      // 只有所有变更节点自身都位于扩展产物内时才能忽略；若按后代包含关系判断，
      // 这种混合宿主更新就会绕过动态覆盖跟踪。
      return changed.length > 0 && changed.every((node) => isWithin(node, artifactSelector));
    };
    const onlyCanonicalIgnoredChildren = (mutation) => {
      if (mutation.type !== 'childList') return false;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      // 整个段落或卡片可能包含 MathJax、代码等后代，但周围正文是新内容。
      // 只忽略自身位于受保护子树中的节点；刻意不采用后代包含关系。
      return changed.length > 0 && changed.every((node) => isWithin(node, protectedSelector));
    };
    const collectCandidates = (state, mutation) => {
      const candidates = new Set();
      const add = (rawNode, includeDescendants) => {
        const element = elementFor(rawNode);
        if (!element) return;
        const closest = element.closest?.(state.rule.selector);
        if (closest) candidates.add(closest);
        if (includeDescendants) {
          if (element.matches?.(state.rule.selector)) candidates.add(element);
          element.querySelectorAll?.(state.rule.selector).forEach((node) => candidates.add(node));
        }
      };
      // hidden/class/style 常落在入场动画的祖先容器，解除隐藏会同时揭示多条
      // 正文；只检查 closest 会漏掉这些新可见后代，导致首轮覆盖报告偏少。
      add(mutation.target, mutation.type === 'attributes');
      mutation.addedNodes.forEach((node) => add(node, true));
      return candidates;
    };
    const processHostMutation = (mutation) => {
      for (const state of states) {
        for (const node of collectCandidates(state, mutation)) {
          const record = state.recordsByNode.get(node);
          if (record && !state.rule.trackDynamic) {
            refreshTranslated(state, record);
            continue;
          }
          if (!state.rule.trackDynamic) continue;
          if (record && mutation.type === 'attributes') {
            const snapshot = canonicalSnapshot(node, null);
            if (!isEligible(node, state.rule, snapshot.sourceText)) detachRecord(state, record, node);
            else refreshTranslated(state, record);
            continue;
          }
          const snapshot = canonicalSnapshot(node, 'dynamic');
          if (!isEligible(node, state.rule, snapshot.sourceText)) {
            if (record) detachRecord(state, record, node);
            continue;
          }
          attachRecord(state, node, snapshot, 'dynamic', true);
        }
      }
    };
    // Receipt 只绑定本次 pass 的原 Node；不沿用动态 record 的重挂身份。
    let completionPass = 0;
    let completionSession = null;
    let nextBinding = 0;
    const completionBindings = new Map();
    const unchangedCompletions = new Map();
    const clearCompletions = () => {
      completionBindings.clear();
      unchangedCompletions.clear();
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (isArtifactOnlyMutation(mutation)) {
          metrics.artifactMutationCount += 1;
          for (const state of states) {
            const node = elementFor(mutation.target)?.closest?.(state.rule.selector);
            const record = node && state.recordsByNode.get(node);
            if (record) refreshTranslated(state, record);
          }
          continue;
        }
        if (isWithin(mutation.target, protectedSelector) || onlyCanonicalIgnoredChildren(mutation)) {
          metrics.ignoredProtectedMutationCount += 1;
          continue;
        }
        metrics.hostMutationCount += 1;
        // 保守复用已有 host epoch：同文交换再返回也立即撤销 pending，不能恢复旧资格。
        clearCompletions();
        processHostMutation(mutation);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    document.addEventListener('scroll', cheapRefresh, true);
    initialScan();

    const activatedMissing = new Set();
    const recordToken = (state, record) => `${state.ruleIndex}:${record.recordId}:${record.generation}`;
    const statusFor = (state, record, token = recordToken(state, record)) => {
      const node = record.node;
      if (!node?.isConnected) {
        return {
          token,
          rule: state.rule.name,
          source: record.sourceText,
          connected: false,
          eligible: false,
          translated: Boolean(state.rule.trackDynamic && record.translatedEver),
          loading: false,
          retry: false,
        };
      }
      const snapshot = canonicalSnapshot(node, null);
      const eligible = isEligible(node, state.rule, snapshot.sourceText);
      const owns = (selector) => [...node.querySelectorAll(selector)]
        .some((artifact) => ownedByRuleNode(artifact, node, state.rule.selector));
      return {
        token,
        rule: state.rule.name,
        source: snapshot.sourceText || record.sourceText,
        connected: true,
        eligible,
        translated: eligible && recordCurrentlyTranslated(state, record),
        loading: eligible && owns('.fluent-read-loading[data-fr-translation-owned="true"]'),
        retry: eligible && owns('.fluent-read-retry-wrapper[data-fr-translation-owned="true"]'),
      };
    };
    const findToken = (token) => {
      const [rawRuleIndex, rawRecordId, rawGeneration] = String(token).split(':');
      const ruleIndex = Number(rawRuleIndex);
      const recordId = Number(rawRecordId);
      const generation = Number(rawGeneration);
      const state = states[ruleIndex];
      if (!state || !Number.isInteger(recordId) || !Number.isInteger(generation)) return null;
      const record = state.recordsById.get(recordId);
      return record ? {state, record, generationMatches: record.generation === generation} : null;
    };

    // 只核对有限的 missing owner；真实 Text 身份和全部结构属性也覆盖尚未交付的 mutation。
    const completionIdentity = (node) => {
      const pending = [node];
      const nodes = [];
      const structure = [];
      let bytes = 0;
      while (pending.length) {
        if (nodes.length >= 4096) return null;
        const current = pending.pop();
        if (current.nodeType === Node.ELEMENT_NODE && current.matches(ownedSelector)) continue;
        const value = current.nodeType === Node.TEXT_NODE ? current.nodeValue
          : current.nodeType === Node.ELEMENT_NODE
            ? [current.tagName, [...current.attributes].map(attribute => [attribute.name, attribute.value]).sort()]
            : current.nodeType;
        const part = JSON.stringify(value);
        bytes += part.length;
        if (bytes > 32768) return null;
        structure.push(part);
        nodes.push(new WeakRef(current));
        if (nodes.length + pending.length + current.childNodes.length > 4096) return null;
        for (let index = current.childNodes.length - 1; index >= 0; index -= 1) pending.push(current.childNodes[index]);
      }
      return {nodes, structure: JSON.stringify(structure)};
    };
    // Only bounded missing-owner queries use presentation-filtered source. Raw
    // canonical text/structure still guard coverage identity and restoration.
    const completionQuerySource = (node) => {
      const clone = snapshotDocument.importNode(node, true);
      const liveDescendants = node.querySelectorAll('*');
      const clonedDescendants = clone.querySelectorAll('*');
      liveDescendants.forEach((live, index) => {
        let style;
        try { style = getComputedStyle(live); } catch { return; }
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          clonedDescendants[index].remove();
        }
      });
      clone.querySelectorAll(ownedSelector).forEach((owned) => owned.remove());
      clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => {
        segment.replaceWith(...segment.childNodes);
      });
      clone.querySelectorAll(protectedSelector).forEach((protectedNode) => protectedNode.remove());
      return normalizeText(clone.textContent);
    };
    const bindingCurrent = (binding) => {
      if (!binding || binding.pass !== completionPass || binding.sessionId !== completionSession ||
          binding.hostRevision !== metrics.hostMutationCount ||
          (binding.deadline !== undefined && Date.now() >= binding.deadline)) return false;
      const node = binding.nodeRef?.deref();
      if (!node) return false;
      const found = findToken(binding.token);
      if (!found?.generationMatches || found.record.node !== node ||
          found.record.sourceText !== binding.source ||
          document.querySelectorAll(binding.selector)[binding.index] !== node) return false;
      const current = completionIdentity(node);
      if (!current || current.structure !== binding.identity.structure ||
          current.nodes.length !== binding.identity.nodes.length ||
          current.nodes.some((reference, index) => reference.deref() !== binding.identity.nodes[index].deref())) return false;
      const status = statusFor(found.state, found.record);
      return status.connected && status.eligible && status.source === binding.source &&
        completionQuerySource(node) === binding.querySource &&
        !status.loading && !status.retry &&
        !node.querySelector(ownedSelector);
    };
    const recordVerifiedUnchanged = (state, record) =>
      bindingCurrent(unchangedCompletions.get(recordToken(state, record)));
    const validReceipt = (receipt, binding) => receipt?.status === 'available' &&
      receipt.reason === 'accepted-result-identical' && receipt.sessionId === completionSession &&
      receipt.source === binding.querySource && receipt.sourceCurrent === true &&
      Array.isArray(receipt.sources) && receipt.sources.length === 1 && receipt.sources[0] === binding.querySource &&
      Array.isArray(receipt.outputs) && receipt.outputs.length === 1 &&
      typeof receipt.outputs[0] === 'string' && normalizeText(receipt.outputs[0]) !== '' &&
      normalizeText(receipt.outputs[0]) === normalizeText(binding.querySource) &&
      Number.isSafeInteger(receipt.generation) && receipt.generation >= 0 &&
      typeof receipt.configuredService === 'string' && receipt.configuredService.trim() !== '' &&
      typeof receipt.targetLanguage === 'string' && receipt.targetLanguage.trim() !== '' &&
      Number.isFinite(receipt.completedAtUnixMs) && receipt.completedAtUnixMs > 0 &&
      Number.isSafeInteger(receipt.renderCommitGeneration) && receipt.renderCommitGeneration >= 0 &&
      receipt.requestBoundary === 'accepted-same-session-result-reuse' &&
      receipt.upstreamDispatchAndRoute === 'unavailable';

    window[trackerKey] = {
      scan: cheapRefresh,
      metrics: () => ({...metrics, pendingCompletionBindings: completionBindings.size}),
      beginRevealRound() { activatedMissing.clear(); },
      beginCompletionPass(sessionId) {
        completionPass += 1;
        completionSession = Number.isSafeInteger(sessionId) && sessionId > 0 ? sessionId : null;
        clearCompletions();
        return completionPass;
      },
      clearCompletionReceipts() { clearCompletions(); },
      discardUnchangedQueries(batch) {
        for (const item of batch) completionBindings.delete(item.bindingId);
      },
      prepareUnchangedQueries(tokens, sessionId, pass, deadline = Date.now() + 2000) {
        completionBindings.clear(); // pending 只保存 WeakRef；忙碌 renderer 也不滞留强 Node 引用。
        if (sessionId !== completionSession || pass !== completionPass || completionSession === null) return [];
        return tokens.slice(0, 16).flatMap((token) => {
          const found = findToken(token);
          if (!found?.generationMatches) return [];
          const {state, record} = found;
          const index = [...document.querySelectorAll(state.rule.selector)].indexOf(record.node);
          const identity = completionIdentity(record.node);
          if (!identity) return [];
          const querySource = completionQuerySource(record.node);
          if (!querySource) return [];
          const binding = {token, selector: state.rule.selector, index, source: record.sourceText, querySource,
            sessionId, pass, nodeRef: new WeakRef(record.node), identity, deadline, hostRevision: metrics.hostMutationCount};
          if (index < 0 || !bindingCurrent(binding)) return [];
          const bindingId = ++nextBinding;
          completionBindings.set(bindingId, binding);
          binding.bindingId = bindingId;
          return [{bindingId, token, hostRevision: binding.hostRevision,
            query: {selector: binding.selector, index, source: binding.querySource, sessionId}}];
        });
      },
      acceptUnchangedQueries(batch, response, sessionId, pass) {
        const validResponse = sessionId === completionSession && pass === completionPass &&
          response?.status === 'success' && response.sessionId === sessionId &&
          Array.isArray(response.outcomes) && response.outcomes.length === batch.length;
        for (let index = 0; index < batch.length; index += 1) {
          const binding = completionBindings.get(batch[index].bindingId);
          completionBindings.delete(batch[index].bindingId);
          const receipt = response?.outcomes?.[index];
          if (!validResponse || !bindingCurrent(binding) || !validReceipt(receipt, binding)) continue;
          const {deadline: _deadline, ...identity} = binding;
          // API generation 是 owner 局部值，仅检查字段形状，不作为唯一身份或 tracker generation。
          unchangedCompletions.set(binding.token, {...identity,
            generation: receipt.generation, renderCommitGeneration: receipt.renderCommitGeneration});
        }
      },
      reset() {
        completionPass += 1;
        completionSession = null;
        clearCompletions();
        activatedMissing.clear();
        for (const state of states) {
          state.recordsById.clear();
          state.recordsByNode = new WeakMap();
          state.recordsByIdentity.clear();
          state.nextRecordId = 0;
        }
        initialScan();
      },
      snapshotMissing() {
        cheapRefresh();
        const missing = [];
        for (const state of states) {
          for (const record of state.recordsById.values()) {
            const token = recordToken(state, record);
            const status = statusFor(state, record, token);
            if (status.connected && status.eligible && !status.translated) missing.push(status);
          }
        }
        return missing;
      },
      activateMissing(token) {
        const found = findToken(token);
        if (!found) return {found: false, token, reason: 'stale-token'};
        if (!found.generationMatches) return {found: false, token, reason: 'stale-generation'};
        const status = statusFor(found.state, found.record, token);
        if (!status.connected) return {...status, found: false, reason: 'disconnected'};
        if (!status.eligible) return {...status, found: false, reason: 'ineligible'};
        if (status.translated) return {...status, found: true, alreadyTranslated: true};
        if (activatedMissing.has(token)) return {...status, found: false, reason: 'already-activated'};
        activatedMissing.add(token);
        found.record.node.scrollIntoView?.({block: 'center', inline: 'nearest', behavior: 'instant'});
        return {...status, found: true, alreadyTranslated: false};
      },
      missingStatuses(tokens) {
        return tokens.map((token) => {
          const found = findToken(token);
          if (found) {
            const status = {...statusFor(found.state, found.record, token),
              verifiedUnchanged: recordVerifiedUnchanged(found.state, found.record),
              completionBindingId: unchangedCompletions.get(token)?.bindingId,
              completionQuerySource: unchangedCompletions.get(token)?.querySource,
              completionPass, completionSessionId: completionSession};
            if (found.generationMatches ||
                (!status.connected && found.state.rule.trackDynamic && found.record.translatedEver)) return status;
            return {...status, translated: false, verifiedUnchanged: false, reason: 'stale-generation'};
          }
          return {token, connected: false, eligible: false, translated: false, loading: false, retry: false,
            rule: '', source: '', reason: 'stale-token'};
        });
      },
      targetStatuses(selector, index) {
        const node = document.querySelectorAll(selector)[index];
        return states.flatMap((state) => {
          const record = node && state.recordsByNode.get(node);
          if (!record) return [];
          const token = recordToken(state, record);
          return [{...statusFor(state, record, token),
            verifiedUnchanged: recordVerifiedUnchanged(state, record),
            completionBindingId: unchangedCompletions.get(token)?.bindingId,
            completionQuerySource: unchangedCompletions.get(token)?.querySource,
            completionPass, completionSessionId: completionSession}];
        });
      },
      diagnoseMissing(tokens) {
        return tokens.slice(0, 8).map((token) => {
          const found = findToken(token);
          const node = found?.record.node;
          if (!(node instanceof HTMLElement)) return {token, connected: false};
          const parent = node.parentElement;
          return {
            token,
            tag: node.tagName,
            html: node.outerHTML.slice(0, 1200),
            parent: parent ? `${parent.tagName.toLowerCase()}#${parent.id}.${parent.className}`.slice(0, 300) : '',
            ruleMatch: node.matches(found.state.rule.selector),
            viewport: (() => {const rect = node.getBoundingClientRect(); return {
              top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height),
              innerHeight,
            };})(),
            ownWrappers: node.querySelectorAll('.fluent-read-bilingual-content').length,
            parentWrappers: parent?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
            nextSibling: node.nextElementSibling?.outerHTML.slice(0, 500) || '',
            translate: node.closest('[translate]')?.getAttribute('translate') || '',
          };
        });
      },
      report() {
        cheapRefresh();
        return states.map((state) => {
          const {rule, recordsById} = state;
          const values = [...recordsById.values()];
          // 对仍连接的节点必须看到“当前”归属于它的 wrapper；translatedEver
          // 只用于虚拟列表中已经移除的动态节点，不能让旧译文冒充重译成功。
          const translated = values.filter((record) => record.node?.isConnected
            ? recordCurrentlyTranslated(state, record) : record.translatedEver);
          const translatedSet = new Set(translated);
          const unchanged = values.filter((record) => !translatedSet.has(record) && recordVerifiedUnchanged(state, record));
          const unchangedSet = new Set(unchanged);
          const missed = values.filter((record) => !translatedSet.has(record) && !unchangedSet.has(record));
          return {
            name: rule.name,
            selector: rule.selector,
            seenCount: values.length,
            dynamicSeenCount: values.filter((record) => record.firstSeenAfterStart).length,
            translatedCount: translated.length,
            verifiedUnchangedCount: unchanged.length,
            unchangedEvidence: unchanged.map(record => ({token: recordToken(state, record),
              source: unchangedCompletions.get(recordToken(state, record))?.querySource, canonicalSource: record.sourceText,
              bindingId: unchangedCompletions.get(recordToken(state, record))?.bindingId})),
            completedCount: translated.length + unchanged.length,
            completionSessionId: completionSession,
            completionPass,
            sourceSamples: values.slice(0, 16).map((record) => record.sourceText),
            matchedSourceIncludes: rule.sourceIncludes.filter((fragment) =>
              values.some((record) => record.sourceText.includes(fragment))),
            missedSamples: missed.slice(0, 8).map((record) => record.sourceText),
          };
        });
      },
      restorationReport() {
        cheapRefresh();
        return states.map(({rule, recordsById}) => {
          const values = [...recordsById.values()];
          const connected = values.filter((record) => record.node?.isConnected);
          const restored = connected.map((record) => ({
            record,
            snapshot: canonicalSnapshot(record.node, 'restoration'),
          }));
          const changed = restored.filter(({record, snapshot}) => snapshot.sourceText !== record.sourceText ||
            snapshot.structure !== record.initialStructure);
          const ownedCount = connected.reduce((count, record) => count +
            [...record.node.querySelectorAll(ownedSelector)]
              .filter((owned) => ownedByRuleNode(owned, record.node, rule.selector)).length, 0);
          return {
            name: rule.name,
            ownedCount,
            changedCount: changed.length,
            missingStaticCount: rule.trackDynamic ? 0 : values.filter((record) => !record.node?.isConnected).length,
            changedSamples: changed.slice(0, 8).map(({record, snapshot}) => ({
              source: record.sourceText,
              current: snapshot.sourceText,
              initialStructure: record.initialStructure.slice(0, 1200),
              currentStructure: snapshot.structure.slice(0, 1200),
            })),
          };
        });
      },
      stop() {
        completionSession = null;
        clearCompletions();
        observer.disconnect();
        document.removeEventListener('scroll', cheapRefresh, true);
      },
    };
  }, {
    coverageRules: rules,
    trackerKey: COVERAGE_TRACKER_KEY,
    ...coverageEligibilityContext(page),
    technicalWords: [...SINGLE_TOKEN_TECHNICAL_WORDS],
  });
}

async function observeCoverage(page) {
  await page.evaluate((trackerKey) => window[trackerKey]?.scan?.(), COVERAGE_TRACKER_KEY);
}

async function readCoverageReport(page) {
  const report = await page.evaluate((trackerKey) => window[trackerKey]?.report?.() || [], COVERAGE_TRACKER_KEY);
  const ledger = ownerCompletionLedgers.get(page);
  for (const state of report) {
    const evidence = new Map((state.unchangedEvidence || []).map(item => [item.bindingId, item]));
    state.verifiedUnchangedCount = ledger && state.completionPass === ledger.pass &&
      state.completionSessionId === ledger.sessionId
      ? [...evidence.values()].filter(item => {
        const accepted = ledger.accepted.get(item.bindingId);
        return accepted && accepted.token === item.token && accepted.query.source === item.source;
      }).length : 0;
    state.completedCount = state.translatedCount + state.verifiedUnchangedCount;
  }
  trustedCoverageSnapshots.set(report, {page, ledger, counts: new Map(report.map((state) => [state.name, {
    translatedCount: state.translatedCount, verifiedUnchangedCount: state.verifiedUnchangedCount,
    completedCount: state.completedCount, completionSessionId: state.completionSessionId,
    completionPass: state.completionPass,
  }]))});
  return report;
}

async function readCoverageStatuses(page, tokens) {
  const statuses = await page.evaluate(({trackerKey, requestedTokens}) =>
    window[trackerKey]?.missingStatuses?.(requestedTokens) || [],
  {trackerKey: COVERAGE_TRACKER_KEY, requestedTokens: tokens});
  return authenticateCoverageStatuses(page, statuses);
}

function authenticateCoverageStatuses(page, statuses) {
  const ledger = ownerCompletionLedgers.get(page);
  for (const status of statuses) {
    const accepted = ledger?.accepted.get(status.completionBindingId);
    status.verifiedUnchanged = Boolean(status.verifiedUnchanged && accepted &&
      ledger.pass === status.completionPass && ledger.sessionId === status.completionSessionId &&
      accepted.token === status.token && accepted.query.source === status.completionQuerySource);
    if (status.verifiedUnchanged) trustedCompletionStatuses.set(status, {page, ledger});
  }
  return statuses;
}

async function readCoverageRestoration(page) {
  return page.evaluate((trackerKey) => window[trackerKey]?.restorationReport?.() || [], COVERAGE_TRACKER_KEY);
}

async function resetCoverageTracker(page) {
  ownerCompletionLedgers.delete(page);
  await page.evaluate((trackerKey) => window[trackerKey]?.reset?.(), COVERAGE_TRACKER_KEY);
}

// 复用 owned profile 的现有 service worker -> frame 0 消息；只读，不打开/激活窗口。
async function createUnchangedCompletionReader(context, page, timeout) {
  const worker = context.serviceWorkers()[0];
  const url = page.url();
  if (!worker || !/^chrome-extension:\/\//u.test(worker.url())) return async () => null;
  const evaluate = async (fn, argument, remainingMs = timeout) => {
    let timer;
    try {
      return await Promise.race([
        worker.evaluate(fn, argument),
        new Promise((resolve) => {timer = setTimeout(() => resolve(null), Math.max(1, Math.min(remainingMs, timeout, 2000)));}),
      ]);
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  const tabId = await evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({active: true});
    const matches = tabs.filter((tab) => tab.url === targetUrl && Number.isInteger(tab.id));
    return matches.length === 1 ? matches[0].id : null;
  }, url);
  if (!Number.isInteger(tabId)) return async () => null;
  const read = async (unchangedQueries, remainingMs = timeout) => {
    if (page.url() !== url || remainingMs <= 0 || !Array.isArray(unchangedQueries) || unchangedQueries.length > 16) return null;
    return evaluate(({tabId: ownedTabId, url: ownedUrl, queries}) => new Promise((resolve) => {
      chrome.tabs.get(ownedTabId, (tab) => {
        if (chrome.runtime.lastError || tab?.url !== ownedUrl) { resolve(null); return; }
        chrome.tabs.sendMessage(ownedTabId, {type: 'getFullPageTranslationState', unchangedQueries: queries},
          {frameId: 0}, (reply) => resolve(chrome.runtime.lastError ? null : reply));
      });
    }), {tabId, url, queries: unchangedQueries}, remainingMs);
  };
  ownedCompletionReaders.add(read);
  return read;
}

// 一个共享截止时间包住新增消息和页面操作；迟到的 Promise 不取得 Node 侧 authority。
async function completionOperation(deadline, operation) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('owner-completion-budget');
  let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('owner-completion-budget')), remaining);
    })]);
    if (Date.now() >= deadline) throw new Error('owner-completion-budget');
    return value;
  } finally { clearTimeout(timer); }
}

async function clearCoverageCompletionPass(page) {
  ownerCompletionLedgers.delete(page);
  try {
    await completionOperation(Date.now() + 2000, () =>
      page.evaluate(key => window[key]?.beginCompletionPass?.(null), COVERAGE_TRACKER_KEY));
  } catch { /* 无认证；迟到的页面清理只可能撤销证明。 */ }
}

async function beginCoverageCompletionPass(page, readCompletion, previousSessionId = null, timeout = 2000) {
  const deadline = Date.now() + Math.min(2000, Math.max(0, timeout));
  ownerCompletionLedgers.delete(page);
  // 先撤销上个 pass；不能等新 session 回读后才清除旧 credit。
  try {
    await completionOperation(deadline, () => page.evaluate((key) => window[key]?.beginCompletionPass?.(null), COVERAGE_TRACKER_KEY));
    const response = ownedCompletionReaders.has(readCompletion)
      ? await completionOperation(deadline, () => readCompletion([], deadline - Date.now())) : null;
    const sessionId = response?.status === 'success' && Array.isArray(response.outcomes) && response.outcomes.length === 0 &&
      Number.isSafeInteger(response.sessionId) && response.sessionId > 0 &&
      response.sessionId !== previousSessionId ? response.sessionId : null;
    const pass = await completionOperation(deadline, () => page.evaluate(({key, sessionId: current}) =>
      window[key]?.beginCompletionPass?.(current), {key: COVERAGE_TRACKER_KEY, sessionId}));
    const identity = {sessionId, pass};
    if (sessionId && Number.isSafeInteger(pass) && pass > 0) ownerCompletionLedgers.set(page, {...identity, accepted: new Map()});
    return identity;
  } catch { return {sessionId: null, pass: null}; }
}

async function verifyCoverageUnchanged(page, readCompletion, identity, timeout, tokens = null) {
  const deadline = Date.now() + Math.min(Math.max(0, timeout), 2000);
  const diagnostic = {status: 'unavailable', reason: 'no-current-authority',
    sessionId: identity?.sessionId ?? null, pass: identity?.pass ?? null, queriedOwners: []};
  let ledger = ownerCompletionLedgers.get(page);
  if (!ownedCompletionReaders.has(readCompletion) || !identity?.sessionId ||
      !ledger || ledger.sessionId !== identity.sessionId || ledger.pass !== identity.pass) {
    ownerCompletionLedgers.delete(page);
    return diagnostic;
  }
  // 每次重新核验都撤销旧快照/状态的 authority，即使 pass/session 尚未换代。
  ledger = {sessionId: ledger.sessionId, pass: ledger.pass, accepted: new Map()};
  ownerCompletionLedgers.set(page, ledger);
  const pageOperation = (fn, argument) => completionOperation(deadline, () => page.evaluate(fn, argument));
  const read = queries => completionOperation(deadline, () => readCompletion(queries, deadline - Date.now()));
  const stillCurrent = (response) => response?.status === 'success' && response.sessionId === identity.sessionId &&
    Array.isArray(response.outcomes) && response.outcomes.length === 0;
  let complete = false;
  try {
    await pageOperation((key) => window[key]?.clearCompletionReceipts?.(), COVERAGE_TRACKER_KEY);
    diagnostic.reason = 'session-query-unavailable';
    if (!stillCurrent(await read([]))) return diagnostic;
    const missing = await pageOperation(({key, tokens}) => {
      const missing = window[key]?.snapshotMissing?.() || [];
      return tokens ? missing.filter(item => tokens.includes(item.token)) : missing;
    }, {key: COVERAGE_TRACKER_KEY, tokens});
    diagnostic.reason = 'verification-incomplete';
    for (let offset = 0; offset < missing.length && Date.now() < deadline; offset += 16) {
      const batch = await pageOperation(({key, tokens, sessionId, pass, deadline}) =>
        window[key]?.prepareUnchangedQueries?.(tokens, sessionId, pass, deadline) || [],
      {key: COVERAGE_TRACKER_KEY, tokens: missing.slice(offset, offset + 16).map((item) => item.token), ...identity, deadline});
      if (!batch.length) continue;
      try {
        const response = await read(batch.map((item) => item.query));
        // 只有 owned worker 回读、页面精确复验均在同一预算内结束后才记录 authority。
        await pageOperation(({key, batch: requested, response: reply, sessionId, pass}) =>
          window[key]?.acceptUnchangedQueries?.(requested, reply, sessionId, pass),
        {key: COVERAGE_TRACKER_KEY, batch, response, ...identity});
        const current = await pageOperation(({key, tokens}) => window[key]?.missingStatuses?.(tokens) || [],
          {key: COVERAGE_TRACKER_KEY, tokens: batch.map(item => item.token)});
        if (response?.status === 'success' && response.sessionId === identity.sessionId &&
            Array.isArray(response.outcomes) && response.outcomes.length === batch.length) {
          batch.forEach((item, index) => {
            const status = current.find(value => value.token === item.token && value.completionBindingId === item.bindingId);
            if (status?.verifiedUnchanged && status.completionQuerySource === item.query.source &&
                acceptedOwnerCompletion(response.outcomes[index], item.query)) ledger.accepted.set(item.bindingId, item);
          });
        }
        for (let index = 0; index < batch.length && diagnostic.queriedOwners.length < 16; index += 1) {
          const item = batch[index];
          const outcome = response?.outcomes?.[index];
          diagnostic.queriedOwners.push({token: item.token, ...item.query,
            status: outcome?.status === 'available' ? 'available' : 'unavailable',
            reason: typeof outcome?.reason === 'string' ? outcome.reason.slice(0, 96) : 'outcome-unavailable',
            exactOwnerAccepted: ledger.accepted.has(item.bindingId)});
        }
      } finally {
        await pageOperation(({key, batch: requested}) => window[key]?.discardUnchangedQueries?.(requested),
          {key: COVERAGE_TRACKER_KEY, batch});
      }
    }
    complete = stillCurrent(await read([]));
    if (complete) { diagnostic.status = 'available'; diagnostic.reason = null; }
  } catch (error) {
    if (error.message !== 'owner-completion-budget') throw error;
  } finally {
    if (!complete) {
      ownerCompletionLedgers.delete(page);
      // pending/accepted 仅 WeakRef；零剩余预算不再启动可阻塞的 cleanup await。
      if (Date.now() < deadline) {
        try { await pageOperation((key) => window[key]?.clearCompletionReceipts?.(), COVERAGE_TRACKER_KEY); }
        catch { /* Node authority 已撤销；页面迟到结果不能认证。 */ }
      }
    }
  }
  diagnostic.authorityRetained = complete && ownerCompletionLedgers.get(page) === ledger;
  return diagnostic;
}

// 页面 tracker 的旗标只描述 DOM 状态；认证必须同时来自 owned worker 的实际响应。
function acceptedOwnerCompletion(receipt, query) {
  return receipt?.status === 'available' && receipt.reason === 'accepted-result-identical' &&
    receipt.sessionId === query.sessionId && receipt.source === query.source && receipt.sourceCurrent === true &&
    Array.isArray(receipt.sources) && receipt.sources.length === 1 && receipt.sources[0] === query.source &&
    Array.isArray(receipt.outputs) && receipt.outputs.length === 1 && typeof receipt.outputs[0] === 'string' &&
    receipt.outputs[0].replace(/[\s\u3000]+/gu, ' ').trim() !== '' &&
    receipt.outputs[0].replace(/[\s\u3000]+/gu, ' ').trim() === query.source.replace(/[\s\u3000]+/gu, ' ').trim() &&
    Number.isSafeInteger(receipt.generation) && receipt.generation >= 0 &&
    Number.isSafeInteger(receipt.renderCommitGeneration) && receipt.renderCommitGeneration >= 0 &&
    typeof receipt.configuredService === 'string' && receipt.configuredService.trim() !== '' &&
    typeof receipt.targetLanguage === 'string' && receipt.targetLanguage.trim() !== '' &&
    Number.isFinite(receipt.completedAtUnixMs) && receipt.completedAtUnixMs > 0 &&
    receipt.requestBoundary === 'accepted-same-session-result-reuse' && receipt.upstreamDispatchAndRoute === 'unavailable';
}

function hasVerifiedUnchangedStatus(status) {
  const trusted = trustedCompletionStatuses.get(status);
  return trusted && ownerCompletionLedgers.get(trusted.page) === trusted.ledger &&
    status.verifiedUnchanged === true && status.connected === true && status.eligible === true &&
    status.loading === false && status.retry === false && !status.reason;
}

// 首目标和 required selector 使用与整页覆盖相同的精确 owner 认证。零 wrapper 本身
// 不算完成；只有当前 pass/session、原 Node/Text 身份和 owned worker 回读同时成立才放行。
async function readFullTargetReadiness(page, selector, index = 0) {
  const state = await page.evaluate(({key, selector, index}) => {
    const target = document.querySelectorAll(selector)[index];
    const wrappers = [...(target?.querySelectorAll('.fluent-read-bilingual-content') || [])];
    return {capturedAt: Date.now(), selector, index,
      target: {exists: Boolean(target?.isConnected), text: target?.textContent?.trim() || '',
        bilingualCount: wrappers.length, translationTexts: wrappers.map(node => node.textContent?.trim() || '')},
      loading: target?.querySelectorAll('.fluent-read-loading').length || 0,
      retry: target?.querySelectorAll('.fluent-read-retry-wrapper').length || 0,
      statuses: window[key]?.targetStatuses?.(selector, index) || []};
  }, {key: COVERAGE_TRACKER_KEY, selector, index});
  authenticateCoverageStatuses(page, state.statuses);
  const translated = state.target.exists && state.target.bilingualCount > 0 &&
    state.target.translationTexts.every(text => /[\u3400-\u9fff]/u.test(text));
  const unchanged = state.target.exists && state.target.bilingualCount === 0 &&
    state.loading === 0 && state.retry === 0 && state.statuses.some(status => {
      const accepted = ownerCompletionLedgers.get(page)?.accepted.get(status.completionBindingId);
      return hasVerifiedUnchangedStatus(status) && accepted?.query.selector === selector && accepted.query.index === index;
    });
  return {...state, ready: translated || unchanged,
    completion: translated ? 'translated' : unchanged ? 'verified-unchanged' : 'unresolved'};
}

// 消息查询和 DOM 轮询共用原有首目标 deadline；不启动翻译、不重试 provider、不延长预算。
async function waitForFullTargetReadiness(page, selector, timeout, verifyUnchanged, deadline = Date.now() + timeout) {
  let lastObservation = null;
  let lastVerification = null;
  try {
    while (Date.now() < deadline) {
      lastObservation = await completionOperation(deadline, () => readFullTargetReadiness(page, selector));
      if (lastObservation.ready) return lastObservation;
      if (lastObservation.loading === 0 && lastObservation.retry === 0 &&
          lastObservation.statuses.length > 0 && verifyUnchanged) {
        lastVerification = await completionOperation(deadline, () => verifyUnchanged(deadline - Date.now(), lastObservation));
        lastObservation = await completionOperation(deadline, () => readFullTargetReadiness(page, selector));
        if (lastObservation.ready) return lastObservation;
      }
      await completionOperation(deadline, () => page.waitForTimeout(Math.min(100, deadline - Date.now())));
    }
  } catch (error) {
    if (error.message !== 'owner-completion-budget') throw error;
  }
  const error = new Error(`first-target-readiness: Timeout ${timeout}ms exceeded.`, {cause: lastObservation});
  error.name = 'TimeoutError';
  error.readinessDiagnostic = {budgetMs: timeout, deadline, lastObservation, lastVerification,
    observationStatus: lastObservation ? 'available-before-deadline' : 'unavailable'};
  throw error;
}

function validateCoverageRevealStatuses(statuses, phase) {
  const unresolved = statuses.filter((status) => !status.translated && !hasVerifiedUnchangedStatus(status));
  if (unresolved.length === 0) return;
  throw new Error(`${phase} 仍有正文节点未收敛：${JSON.stringify(unresolved.map((status) => ({
    token: status.token,
    rule: status.rule,
    source: status.source,
    connected: status.connected,
    eligible: status.eligible,
    loading: status.loading,
    retry: status.retry,
    reason: status.reason || (status.retry ? 'terminal-retry' : 'missing-wrapper'),
  })))}`);
}

// 候选发现遍历会刻意分时执行。测试中的合成滚动可能在 IntersectionObserver 挂接前
// 越过较晚发现的节点，而真实用户返回该区域时会触发它。这里冻结一批当前仍连接、
// 尚未满足严格覆盖的节点，并各自给予一次可见机会。覆盖标准本身不会放宽：
// 有界收敛后每个 missing 必须有中文 wrapper 或当前 pass 精确 owner 完成 receipt。
async function settleCoverageByReveal(page, timeout, phase, round = 0, verifyUnchanged) {
  const startedAt = Date.now();
  const maxAttempts = 256;
  const dwellMs = 2000;
  const batch = await page.evaluate(
    (trackerKey) => {
      const tracker = window[trackerKey];
      tracker?.beginRevealRound?.();
      return tracker?.snapshotMissing?.() || [];
    },
    COVERAGE_TRACKER_KEY,
  );
  // 每个叶节点固定停留一次，整批停留之外再保留 timeout 等待共享队列收敛。
  // 若只给固定 timeout，长页合法批次会在逐节点阶段必然耗尽预算。
  const deadline = startedAt + batch.length * dwellMs + timeout;
  if (batch.length === 0) return [];
  reportProgress(`${phase} 第 ${round + 1} 轮回访 ${batch.length} 个仍缺译的正文节点`);
  if (batch.length > maxAttempts) {
    throw new Error(`${phase} 缺失节点超过有界唤醒上限：${JSON.stringify({
      missingCount: batch.length,
      maxAttempts,
      attempted: 0,
      unattempted: batch.slice(0, 12).map(({token, rule, source}) => ({token, rule, source})),
    })}`);
  }

  const tokens = batch.map((status) => status.token);
  let attempted = 0;
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index];
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`${phase} 逐节点唤醒预算耗尽：${JSON.stringify({
        timeout,
        attempted,
        unattempted: batch.slice(index, index + 12).map(({token, rule, source}) => ({token, rule, source})),
      })}`);
    }
    const activated = await page.evaluate(
      ({trackerKey, token}) => window[trackerKey]?.activateMissing?.(token) ||
        {found: false, token, reason: 'tracker-unavailable'},
      {trackerKey: COVERAGE_TRACKER_KEY, token: item.token},
    );
    if (!activated.found && !activated.alreadyTranslated) {
      validateCoverageRevealStatuses([activated], phase);
    }
    attempted += 1;
    // 精确叶节点一旦提交译文就继续下一项；未提交时保留完整可见窗口，
    // 等浏览器 IO 回调和分时发现任务。避免对已完成的长页节点空等。
    try {
      await page.waitForFunction(
        ({trackerKey, token}) => window[trackerKey]?.missingStatuses?.([token])?.[0]?.translated === true,
        {trackerKey: COVERAGE_TRACKER_KEY, token: item.token},
        {timeout: Math.min(dwellMs, Math.max(1, deadline - Date.now())), polling: 100},
      );
    } catch (error) {
      if (!/Timeout/i.test(error.message)) throw error;
    }
    await observeCoverage(page);
  }

  // 所有新可见候选共用常规页面队列。整批只等待一次，避免按缺失叶节点数量
  // 成倍累加 provider 的最坏重试预算。
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`${phase} 已用尽 ${timeout}ms 总预算，无法等待唤醒批次结束`);
  }
  await waitForTranslationIdle(page, remaining, `${phase}逐节点唤醒后`, 0);
  await observeCoverage(page);
  if (verifyUnchanged) await verifyUnchanged(Math.max(0, deadline - Date.now()));
  const statuses = await readCoverageStatuses(page, tokens);
  const unresolved = statuses.filter((status) => !status.translated && !hasVerifiedUnchangedStatus(status));
  if (unresolved.length > 0 && round < 2 && unresolved.length < batch.length) {
    // 免费服务慢请求占满并发槽时，先等已派发请求收敛，再为尚未派发的节点
    // 提供一次新的可见机会；不能让快速模拟滚动永久撤回它们的 pending。
    return settleCoverageByReveal(page, timeout, phase, round + 1, verifyUnchanged);
  }
  if (unresolved.length > 0) {
    const diagnostics = await page.evaluate(
      ({trackerKey, requestedTokens}) => window[trackerKey]?.diagnoseMissing?.(requestedTokens) || [],
      {trackerKey: COVERAGE_TRACKER_KEY, requestedTokens: tokens.filter((token) =>
        statuses.some((status) => status.token === token && !status.translated && !hasVerifiedUnchangedStatus(status)))},
    );
    process.stderr.write(`${phase} 诊断：${JSON.stringify(diagnostics)}\n`);
    const runtimeState = await page.evaluate(() => {
      const host = document.querySelector('#fluent-read-translation-status-container');
      const panel = host?.shadowRoot?.querySelector('.fr-translation-progress');
      return {
        progress: panel ? {...panel.dataset} : null,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        scrollY: window.scrollY,
      };
    });
    process.stderr.write(`${phase} 运行状态：${JSON.stringify(runtimeState)}\n`);
  }
  validateCoverageRevealStatuses(statuses, phase);
  return statuses;
}

function loadPlaywright(root) {
  try {
    return require('playwright');
  } catch {
    const loader = createRequire(path.join(path.resolve(root), '__fluentread_site_loader__.cjs'));
    return loader('playwright');
  }
}

function loadFocusSafeHelper(helperPath) {
  if (!helperPath) return null;
  const resolved = path.resolve(helperPath);
  const helper = require(resolved);
  for (const name of [
    'launchFocusSafePersistentContext',
    'newPageWithoutForeground',
    'activateExtensionTabWithoutForeground',
  ]) {
    if (typeof helper[name] !== 'function') {
      throw new Error(`--focus-safe-helper 缺少 ${name}`);
    }
  }
  return helper;
}

function assertDedicatedProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
  ];
  if (forbidden.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) {
    throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
  }
}

function normalizeConfig(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readConfig(context, timeout, createPage, activateTab) {
  const workers = context.serviceWorkers();
  const worker = workers[0] || await context.waitForEvent('serviceworker', {timeout: Math.min(timeout, 30000)});
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) throw new Error('没有找到扩展 service worker');
  const popup = await createPage(context, timeout);
  let primaryError;
  try {
    await popup.goto(`chrome-extension://${match[1]}/popup.html`, {waitUntil: 'domcontentloaded', timeout: 30000});
    await activateTab(context, popup, timeout);
    const response = await popup.evaluate((messageTimeout) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台配置读取超时')), messageTimeout);
      chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}, (reply) => {
        const error = chrome.runtime.lastError;
        clearTimeout(timer);
        if (error) {
          reject(new Error(error.message || '后台配置读取失败'));
          return;
        }
        resolve(reply);
      });
    }), Math.min(timeout, 10000));
    if (response?.success !== true) {
      throw new Error(response?.error || '后台配置读取没有返回结果');
    }
    return {extensionId: match[1], config: normalizeConfig(response.value)};
  } catch (error) {primaryError = error; throw error;}
  finally {
    try {await popup.close();} catch (error) {
      if (!primaryError) throw error;
      process.stderr.write(`Popup close failed: ${error.stack || error}\n`);
    }
  }
}

async function waitFor(page, predicate, timeout, argument) {
  await page.waitForFunction(predicate, argument, {timeout});
}

// MathJax v2 的宿主排版可能在 DOMContentLoaded 后继续改写段落。
// 仅排队等待现有任务，不调用 Typeset，也不修改宿主内容或忽略恢复断言。
// https://docs.mathjax.org/en/v2.7-latest/advanced/queues.html
async function waitForHostMathRendering(page, timeout) {
  const state = await page.evaluate(async (timeoutMs) => {
    const mathJax = window.MathJax;
    if (typeof mathJax?.Hub?.Queue !== 'function') return {detected: false, errors: []};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('宿主 MathJax 初始排版等待超时')), timeoutMs);
      try {
        mathJax.Hub.Queue(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    return {
      detected: true,
      version: mathJax.version || '',
      errors: [...document.querySelectorAll('.MathJax_Error')].map((node) => ({
        id: node.id,
        text: node.textContent?.trim() || '',
      })),
    };
  }, timeout);
  if (state.errors.length > 0) {
    reportProgress(`翻译前宿主公式已有错误：${JSON.stringify(state.errors)}`);
  }
  return state;
}

async function waitForStableTarget(page, selector, timeout) {
  try {
    await page.waitForSelector(selector, {state: 'attached', timeout});
    // 部分站点通过 IntersectionObserver 在进入视口后移除 hidden 入场标记，
    // 同时用 CSS 保留真实布局。先滚动到有布局的候选，再等待语义可见性；
    // 不能先等 hidden 消失再滚动，否则 MkDocs 这类页面永远无法开始测试。
    const revealIndex = await page.evaluate((targetSelector) => [...document.querySelectorAll(targetSelector)]
      .findIndex((target) => {
        if (target.closest('[aria-hidden="true"], [inert]')) return false;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          Boolean(target.textContent?.trim());
      }), selector);
    if (revealIndex >= 0) {
      assertPageFocusAllowed(page);
      await page.locator(selector).nth(revealIndex).scrollIntoViewIfNeeded({timeout});
    }
    await waitFor(page, (targetSelector) => {
      return [...document.querySelectorAll(targetSelector)].some((target) => {
        if (target.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(target.textContent?.trim());
      });
    }, timeout, selector);
    const rawIndex = await page.evaluate((targetSelector) => [...document.querySelectorAll(targetSelector)]
      .findIndex((target) => {
        if (target.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(target.textContent?.trim());
      }), selector);
    assertPageFocusAllowed(page);
    await page.locator(selector).nth(rawIndex).scrollIntoViewIfNeeded();
  } catch (error) {
    assertPageFocusAllowed(page);
    const diagnostics = await page.evaluate((targetSelector) => ({
      url: location.href,
      title: document.title,
      selector: targetSelector,
      count: document.querySelectorAll(targetSelector).length,
      bodyText: (document.body?.innerText || '').replace(/\s+/gu, ' ').slice(0, 500),
      // 标题节点未出现时保留真实 issue 链接和列表状态，不用泛化 selector 掩盖失败。
      mainText: (document.querySelector('main')?.innerText || '').replace(/\s+/gu, ' ').slice(0, 6000),
      issueLinks: [...document.querySelectorAll('a[href]')]
        .filter((node) => /\/issues\/\d+(?:[?#]|$)/u.test(node.getAttribute('href') || ''))
        .slice(0, 20).map((node) => ({
          href: node.getAttribute('href'),
          testId: node.getAttribute('data-testid'),
          text: (node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 240),
          html: node.outerHTML.slice(0, 900),
        })),
      busyRegions: [...document.querySelectorAll('main [aria-busy="true"], main [role="alert"]')]
        .slice(0, 8).map((node) => ({role: node.getAttribute('role'), busy: node.getAttribute('aria-busy'),
          text: (node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 300)})),
      samples: [...document.querySelectorAll('main p, article p, h1, h2, [itemprop="description"]')]
        .slice(0, 12).map((node) => ({tag: node.tagName, className: node.className, text: (node.textContent || '').trim().slice(0, 100)})),
    }), selector);
    throw new Error(`${error.message}\n目标 selector 诊断：${JSON.stringify(diagnostics)}`);
  }
  await page.waitForTimeout(1000);
}

// Read-only preconditions for one native dismiss action. Accessibility attributes are never rewritten.
function readDismissiblePromotionStateInPage({dialogSelector, buttonSelector, contentSelector, expectedUrl,
  afterDismissal = false, waitForButton = false, diagnostics = false}) {
  const paint = node => {
    if (!node) return {painted: false, reasons: ['missing']};
    const reasons = [], rect = node.getBoundingClientRect();
    if (!node.isConnected) reasons.push('disconnected');
    if (node.closest('[hidden]')) reasons.push('hidden-attribute');
    if (!(rect.width > 0 && rect.height > 0)) reasons.push('no-rect');
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none') reasons.push(`display:none:${current.localName}`);
      if (['hidden', 'collapse'].includes(style.visibility)) reasons.push(`visibility:${style.visibility}:${current.localName}`);
      if (style.opacity === '0') reasons.push(`opacity:0:${current.localName}`);
    }
    return {painted: reasons.length === 0, reasons, width: rect.width, height: rect.height};
  };
  const dialogs = [...document.querySelectorAll(dialogSelector)], buttons = [...document.querySelectorAll(buttonSelector)];
  const contents = [...document.querySelectorAll(contentSelector)];
  const visibleDialogs = dialogs.filter(node => paint(node).painted);
  const blockers = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')]
    .filter(node => paint(node).painted);
  const button = buttons[0], content = contents[0];
  const contentHidden = !!content?.closest('[hidden],[inert],[aria-hidden="true"]');
  const ariaHiddenAncestor = button?.closest('[aria-hidden="true"]');
  const inertAncestor = button?.closest('[inert]');
  // Native inactive promotion markup can be present before its hiding CSS settles.
  // Only an external ancestor containing the whole known dialog may wait; no click occurs in that state.
  const inactiveKnownPromotionAncestor = !!ariaHiddenAncestor && !!content && !inertAncestor && dialogs.length === 1 &&
    ariaHiddenAncestor !== dialogs[0] && ariaHiddenAncestor.contains(dialogs[0]) && !ariaHiddenAncestor.contains(content);
  const formAttributes = ['form', 'formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate'];
  const state = {urlUnchanged: location.href === expectedUrl, path: location.pathname,
    dialogCount: dialogs.length, visibleDialogCount: visibleDialogs.length, blockingDialogCount: blockers.length,
    unrecognizedBlockingDialogs: blockers.filter(node => !visibleDialogs.includes(node)).map(node => ({tag: node.localName,
      role: node.getAttribute('role'), ariaModal: node.getAttribute('aria-modal')})),
    dialog: dialogs[0] ? {role: dialogs[0].getAttribute('role'), ariaModal: dialogs[0].getAttribute('aria-modal'), ...paint(dialogs[0])} : null,
    button: {count: buttons.length, tag: button?.localName || null, insideDialog: !!button && dialogs.length === 1 && dialogs[0].contains(button),
      typeAttribute: button?.getAttribute('type') ?? null, effectiveType: button?.type ?? null,
      ancestorForm: !!button?.closest('form'), associatedForm: !!button?.form,
      formAttributes: button ? formAttributes.filter(name => button.hasAttribute(name)) : [],
      disabled: !!button && (!!button.disabled || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'),
      inaccessibleAncestor: !!ariaHiddenAncestor || !!inertAncestor, inactiveKnownPromotionAncestor,
      ariaHiddenAncestor: ariaHiddenAncestor ? {tag: ariaHiddenAncestor.localName, id: ariaHiddenAncestor.id} : null,
      inertAncestor: inertAncestor ? {tag: inertAncestor.localName, id: inertAncestor.id} : null, ...paint(button)},
    content: {count: contents.length, hasText: !!content?.textContent?.trim(), hiddenOrInertAncestor: contentHidden,
      insideDialog: !!content && dialogs.some(dialog => dialog.contains(content)), ...paint(content)}};
  if (diagnostics) return state;
  const reject = reason => {throw new Error(`Dismissible promotion preparation refused: ${reason}; ${JSON.stringify(state)}`);};
  if (!state.urlUnchanged) reject('URL changed');
  if (/(?:^|\/)(?:authwall|login|signin|signup|checkpoint|challenge|captcha)(?:\/|$)/iu.test(location.pathname)) {
    reject('authentication or challenge path');
  }
  if (state.unrecognizedBlockingDialogs.length) reject('unrecognized blocking dialog');
  if (contents.length !== 1 || !state.content.hasText || !state.content.painted) {
    if (afterDismissal) return false;
    reject('public content is absent, ambiguous or not rendered');
  }
  // A hidden known dialog needs no action when the public article is already readable.
  const needsDialog = visibleDialogs.length > 0 || (contentHidden && dialogs.length > 0);
  if (needsDialog) {
    if (dialogs.length !== 1 || visibleDialogs.length > 1 || dialogs[0].getAttribute('role') !== 'dialog' ||
        dialogs[0].getAttribute('aria-modal') !== 'true') reject('promotion dialog is not unique and modal');
    if (state.content.insideDialog) reject('configured content is inside the promotion');
    if (afterDismissal) return false;
    if (buttons.length !== 1 || !state.button.insideDialog || button.localName !== 'button' || state.button.disabled ||
        (state.button.inaccessibleAncestor && !inactiveKnownPromotionAncestor)) reject('dismiss button is not unique, native and actionable inside the promotion');
    const type = state.button.typeAttribute;
    // Native LinkedIn's close button omits type. It is safe only without any associated/ancestor form.
    if ((type !== null && type.toLowerCase() !== 'button') || state.button.ancestorForm || state.button.associatedForm ||
        state.button.formAttributes.length) reject('dismiss button can submit/reset or belongs to a form');
    if (inactiveKnownPromotionAncestor || !state.dialog.painted || !state.button.painted) {
      if (waitForButton) return false;
      reject('known promotion dismiss button is not yet active and painted');
    }
    return {action: 'dismiss', publicContentCount: contents.length};
  }
  if (contentHidden) {
    if (afterDismissal) return false;
    reject('public content remains hidden or inert without a known promotion');
  }
  return {action: 'none', publicContentCount: contents.length};
}

async function prepareDismissiblePromotion(page, config, expectedUrl, timeout) {
  const normalized = normalizeDismissiblePromotion(config);
  if (!normalized) return undefined;
  const argument = {...normalized, expectedUrl}, deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    if (!await page.evaluate(readDismissiblePromotionStateInPage, {...argument, waitForButton: true})) {
      const painted = await page.waitForFunction(readDismissiblePromotionStateInPage,
        {...argument, waitForButton: true}, {timeout: remaining(), polling: 100});
      await painted?.dispose?.();
    }
    const before = await page.evaluate(readDismissiblePromotionStateInPage, argument);
    if (before.action === 'none') return {status: 'not-present', nativeClicks: 0, ...normalized, url: expectedUrl};
    if (Date.now() >= deadline) throw new Error('native preparation deadline exceeded before click');
    assertPageFocusAllowed(page);
    await page.locator(normalized.buttonSelector).click({timeout: remaining()});
    if (page.url() !== expectedUrl) throw new Error('URL changed after click');
    const ready = await page.waitForFunction(readDismissiblePromotionStateInPage,
      {...argument, afterDismissal: true}, {timeout: remaining(), polling: 100});
    await ready?.dispose?.();
    const after = await page.evaluate(readDismissiblePromotionStateInPage, {...argument, afterDismissal: true});
    if (!after || after.action !== 'none' || page.url() !== expectedUrl) throw new Error('public content did not become readable');
    return {status: 'dismissed', nativeClicks: 1, ...normalized, url: expectedUrl};
  } catch (error) {
    assertPageFocusAllowed(page);
    let details;
    try {details = await page.evaluate(readDismissiblePromotionStateInPage, {...argument, diagnostics: true});}
    catch (diagnosticError) {details = {status: 'unavailable', reason: diagnosticError.message};}
    const failure = new Error(`Dismissible promotion preparation refused: ${error.message}\npromotion diagnostics: ${JSON.stringify(details)}`, {cause: error});
    failure.promotionDiagnostic = details;
    throw failure;
  }
}

async function waitForPageContract(
  page,
  requiredSelectors,
  forbiddenSelectors,
  forbiddenMustExistSelectors,
  interactionSelectors,
  timeout,
) {
  const contract = {
    required: requiredSelectors,
    forbidden: forbiddenSelectors,
    forbiddenMustExist: forbiddenMustExistSelectors,
    interactions: interactionSelectors,
  };
  try {
    await waitFor(page, ({required, forbiddenMustExist, interactions}) => {
      const firstVisibleTextNode = (selector) => [...document.querySelectorAll(selector)].find((node) => {
        if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(node.textContent?.trim());
      });
      return required.every((selector) => Boolean(firstVisibleTextNode(selector))) &&
        forbiddenMustExist.every((selector) => Boolean(document.querySelector(selector))) &&
        interactions.every((selector) => document.querySelector(selector));
    }, timeout, contract);
  } catch (error) {
    const diagnostics = await page.evaluate(({required, forbidden, forbiddenMustExist, interactions}) => ({
      url: location.href,
      required: required.map((selector) => ({selector, count: document.querySelectorAll(selector).length})),
      forbidden: forbidden.map((selector) => ({selector, count: document.querySelectorAll(selector).length})),
      forbiddenMustExist: forbiddenMustExist.map((selector) => ({
        selector,
        count: document.querySelectorAll(selector).length,
      })),
      interactions: interactions.map((selector) => ({selector, count: document.querySelectorAll(selector).length})),
    }), contract);
    throw new Error(`${error.message}\n页面 contract 诊断：${JSON.stringify(diagnostics)}`);
  }
  await page.waitForTimeout(1000);
}

// One serialized page callback keeps capture/assert projection predicates identical.
// Only the two observed LearnOpenGL native empty slots are opaque; no host DOM writes.
function readPageContractStateInPage({
  required, forbidden = [], interactions = [], dynamicForbidden = [], optionalForbidden = [],
  mutableForbidden = [], baselineState, url, captureIdentity = false, navIdentity,
}) {
  const snapshotDocument = document.cloneNode(false);
  const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
  const ownedSelector = [
    '.fluent-read-bilingual-content', '.fluent-read-loading', '.fluent-read-retry-wrapper',
    '[data-fr-translation-owned="true"]',
  ].join(', ');
  const attributes = (node) => [...node.attributes].map(({name, value}) => [name, value])
    .sort(([a], [b]) => a.localeCompare(b));
  const visit = (current, opaqueSlots) => {
    if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.nodeValue) ? '#text' : null;
    if (current.nodeType !== Node.ELEMENT_NODE) return null;
    return [current.tagName.toLowerCase(), opaqueSlots?.has(current)
      ? ['#native-host-slot'] : [...current.childNodes].map((child) => visit(child, opaqueSlots)).filter(Boolean)];
  };
  const nativeSlotsFor = (node, selector) => {
    if (selector !== '#nav' || node.tagName !== 'DIV' || node.id !== 'nav' || typeof location === 'undefined' ||
        location.href !== 'https://learnopengl.com/Getting-started/Coordinate-Systems' || document.querySelectorAll('#nav').length !== 1 ||
        node.children.length !== 10) return [];
    return [['leftfourthtenthad', 6], ['lefteighttenthad', 8]].flatMap(([id, index]) => {
      if (document.querySelectorAll(`#${id}`).length !== 1) return [];
      const slot = document.querySelector(`#${id}`);
      if (slot?.tagName !== 'DIV' || slot.parentElement !== node || node.children[index] !== slot ||
          normalizeText(slot.textContent) || slot.querySelector('a') || slot.matches(ownedSelector) ||
          slot.querySelector(ownedSelector)) return [];
      return [slot];
    });
  };
  const parentsOf = (anchor, nav) => {
    const parents = [];
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      parents.push(parent);
      if (parent === nav) break;
    }
    return parents;
  };
  const makeIdentity = (nav, slots) => ({nav, slots, anchors: [...nav.querySelectorAll('a')].map((node) => ({
    node, parents: parentsOf(node, nav), attributes: attributes(node), text: node.textContent,
    href: node instanceof HTMLAnchorElement ? node.href : '', type: 'type' in node ? String(node.type || '') : '',
  }))});
  const identityMatches = (nav, slots, identity) => {
    if (!identity || identity.nav !== nav || !nav.isConnected || identity.slots.length !== slots.length ||
        slots.some((slot, index) => identity.slots[index] !== slot || !slot.isConnected)) return false;
    const anchors = [...nav.querySelectorAll('a')];
    return anchors.length === identity.anchors.length && identity.anchors.every((initial, index) => {
      const node = anchors[index], parents = parentsOf(node, nav);
      return node === initial.node && node.isConnected && node.textContent === initial.text &&
        (node instanceof HTMLAnchorElement ? node.href : '') === initial.href &&
        ('type' in node ? String(node.type || '') : '') === initial.type &&
        JSON.stringify(attributes(node)) === JSON.stringify(initial.attributes) &&
        parents.length === initial.parents.length && parents.every((parent, i) => parent === initial.parents[i]);
    });
  };
  let identity = null;
  const hostNativeDiagnostics = [];
  const forbiddenSignature = (node, selector) => {
    const slots = nativeSlotsFor(node, selector);
    const project = Boolean(slots.length && (captureIdentity || navIdentity?.identity));
    const opaqueSlots = project ? new Set(slots) : null;
    const signature = {
      tagName: node.tagName, id: node.id, role: node.getAttribute('role') || '',
      ariaLabel: node.getAttribute('aria-label') || '', value: 'value' in node ? String(node.value || '') : '',
      text: normalizeText(node.textContent), structure: JSON.stringify(visit(node, opaqueSlots)),
    };
    if (project) {
      if (captureIdentity) identity = makeIdentity(node, slots);
      signature.nativeSlotProjection = {slots: slots.map(slot => ({tagName: slot.tagName, id: slot.id,
        directElementChildIndex: [...node.children].indexOf(slot), attributes: attributes(slot)})),
        navIdentityValid: captureIdentity || identityMatches(node, slots, navIdentity.identity)};
      const protectedAttributes = [];
      const collectProtectedAttributes = (current, position) => {
        protectedAttributes.push({position, tagName: current.tagName, attributes: attributes(current)});
        if (!opaqueSlots.has(current)) [...current.children].forEach((child, index) => collectProtectedAttributes(child, [...position, index]));
      };
      collectProtectedAttributes(node, []);
      signature.protectedAttributes = protectedAttributes;
      hostNativeDiagnostics.push({selector, slotIds: slots.map(slot => slot.id), outerHTML: node.outerHTML,
        unprojectedStructure: JSON.stringify(visit(node, null))});
    }
    return signature;
  };
  const firstVisibleTextNode = (selector) => [...document.querySelectorAll(selector)].find((node) => {
    if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
      Boolean(node.textContent?.trim());
  });
  const definitions = baselineState ? baselineState.forbiddenState : forbidden.map((selector) => ({
    selector, dynamic: dynamicForbidden.includes(selector), optional: optionalForbidden.includes(selector),
    mutable: mutableForbidden.includes(selector),
  }));
  const forbiddenState = definitions.map(({selector, dynamic, optional, mutable}) => {
    const nodes = [...document.querySelectorAll(selector)].filter((node) => !node.closest('.fluent-read-bilingual-content'));
    return {selector, dynamic, optional, mutable, count: nodes.length,
      translatedDescendants: nodes.reduce((count, node) => count + node.querySelectorAll('.fluent-read-bilingual-content').length, 0),
      ownedDescendants: nodes.reduce((count, node) => count + (node.matches(ownedSelector) ? 1 : 0) + node.querySelectorAll(ownedSelector).length, 0),
      signatures: nodes.map((node) => forbiddenSignature(node, selector))};
  });
  const semanticSnapshot = (node) => {
    if (!node) return {sourceText: '', structure: ''};
    const clone = snapshotDocument.importNode(node, true);
    clone.querySelectorAll(ownedSelector).forEach((owned) => owned.remove());
    clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => segment.replaceWith(...segment.childNodes));
    return {sourceText: normalizeText(clone.textContent), structure: JSON.stringify(visit(clone, null))};
  };
  const requiredState = required.map((selector) => baselineState
    ? {selector, count: document.querySelectorAll(selector).length, exists: Boolean(firstVisibleTextNode(selector))}
    : {selector, minimumCount: document.querySelectorAll(selector).length, ...semanticSnapshot(firstVisibleTextNode(selector))});
  const interactionDefinitions = baselineState ? baselineState.interactionState : interactions.map((selector) => ({selector}));
  const interactionState = interactionDefinitions.map((initial) => {
    const {selector} = initial;
    const nodes = [...document.querySelectorAll(selector)].filter((node) => !node.closest('.fluent-read-bilingual-content'));
    const matchesInitialIdentity = (candidate) => (candidate instanceof HTMLAnchorElement ? candidate.href : '') === initial.href &&
      candidate.tagName === initial.tagName && ('type' in candidate ? String(candidate.type || '') : '') === initial.type &&
      (candidate.getAttribute?.('role') || '') === initial.role;
    const visible = (candidate) => {const rect = candidate.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;};
    const node = (baselineState && nodes.find(matchesInitialIdentity)) || nodes.find(visible) || nodes[0];
    const common = {selector, tagName: node?.tagName || '', href: node instanceof HTMLAnchorElement ? node.href : '',
      type: node && 'type' in node ? String(node.type || '') : '', disabled: Boolean(node?.matches?.(':disabled')),
      ariaDisabled: node?.getAttribute?.('aria-disabled') || '', role: node?.getAttribute?.('role') || ''};
    return baselineState ? {...common, count: nodes.length, connected: Boolean(node?.isConnected), focusable: Boolean(node &&
      !node.matches(':disabled') && (node.matches('a[href], button, input, select, textarea, summary, [contenteditable="true"]') || node.tabIndex >= 0))}
      : {...common, minimumCount: nodes.length};
  });
  const snapshot = baselineState ? {urlUnchanged: location.href === url,
    documentHealthy: document.readyState !== 'loading' && Boolean(document.documentElement?.isConnected) && Boolean(document.body?.isConnected),
    requiredState, forbiddenState, interactionState} : {requiredState, forbiddenState, interactionState};
  if (hostNativeDiagnostics.length) snapshot.hostNativeDiagnostics = hostNativeDiagnostics;
  return captureIdentity ? {snapshot, identity} : snapshot;
}

async function capturePageContract(
  page, requiredSelectors, forbiddenSelectors, interactionSelectors, dynamicForbiddenSelectors,
  optionalForbiddenSelectors, mutableForbiddenSelectors = [],
) {
  const argument = {required: requiredSelectors, forbidden: forbiddenSelectors, interactions: interactionSelectors,
    dynamicForbidden: dynamicForbiddenSelectors, optionalForbidden: optionalForbiddenSelectors,
    mutableForbidden: mutableForbiddenSelectors};
  if (typeof page.url === 'function' && page.url() === 'https://learnopengl.com/Getting-started/Coordinate-Systems' &&
      forbiddenSelectors.includes('#nav')) {
    if (typeof page.evaluateHandle !== 'function') throw new Error('LearnOpenGL protected nav identity handle unavailable');
    const handle = await page.evaluateHandle(readPageContractStateInPage, {...argument, captureIdentity: true});
    try {
      const snapshotHandle = await handle.getProperty('snapshot');
      let snapshot, readingFailure, readFailed = false;
      try {snapshot = await snapshotHandle.jsonValue();} catch (error) {readingFailure = error; readFailed = true;}
      try {await snapshotHandle.dispose();} catch (cleanupError) {
        if (readFailed) {
          throw new AggregateError([readingFailure, cleanupError], 'Protected nav snapshot read/dispose failed', {cause: readingFailure});
        }
        throw cleanupError;
      }
      if (readFailed) throw readingFailure;
      if (snapshot.forbiddenState.some(({signatures}) => signatures.some((signature) => signature.nativeSlotProjection))) {
        protectedNavContractHandles.set(snapshot, {page, handle});
      } else await handle.dispose();
      return snapshot;
    } catch (error) {
      try {await handle.dispose();} catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Protected nav snapshot/handle cleanup failed', {cause: error});
      }
      throw error;
    }
  }
  return page.evaluate(readPageContractStateInPage, argument);
}

function reconcileForbiddenContractState(initial, current) {
  const diagnosticState = (state) => ({
    ...state,
    signatureCount: state.signatures.length,
    signatures: state.signatures.slice(0, 12),
  });
  if (current.translatedDescendants !== 0 || current.ownedDescendants !== 0) {
    return `forbidden DOM 出现译文：${JSON.stringify(diagnosticState(current))}`;
  }
  if (initial.optional && initial.count === 0) {
    if (current.count === 0) return null;
    if (!initial.dynamic) {
      return `可选 forbidden DOM 在静态 contract 后出现：${JSON.stringify({
        before: diagnosticState(initial),
        after: diagnosticState(current),
      })}`;
    }
    // 宿主页可能延迟挂载可选 renderer。采用它首次干净且不含扩展产物的快照，
    // 使恢复和重新翻译必须像处理基线已有的动态禁止子树一样，保留其精确文本与拓扑。
    Object.assign(initial, current);
    return null;
  }
  if (initial.dynamic) {
    if (initial.mutable) {
      if (current.count < initial.count) {
        return `宿主可变 forbidden DOM 数量减少：${JSON.stringify({
          before: diagnosticState(initial),
          after: diagnosticState(current),
        })}`;
      }
      // 可变 renderer 完成时可能追加根节点。同步推进基线水位，防止后续阶段再次静默丢失。
      initial.count = current.count;
      return null;
    }
    const currentSignatures = new Map();
    for (const signature of current.signatures) {
      const key = JSON.stringify(signature);
      currentSignatures.set(key, (currentSignatures.get(key) || 0) + 1);
    }
    // Relative times and publisher labels can repeat. Each baseline node needs
    // its own matching occurrence; one survivor cannot account for two originals.
    const missingBaseline = initial.signatures.some((signature) => {
      const key = JSON.stringify(signature);
      const remaining = currentSignatures.get(key) || 0;
      if (!remaining) return true;
      currentSignatures.set(key, remaining - 1);
      return false;
    });
    if (current.count < initial.count || missingBaseline) {
      return `动态 forbidden DOM 基线丢失：${JSON.stringify({
        before: diagnosticState(initial),
        after: diagnosticState(current),
      })}`;
    }
    return null;
  }
  if (JSON.stringify(current) !== JSON.stringify(initial)) {
    return `forbidden DOM 被修改：${JSON.stringify({
      before: diagnosticState(initial),
      after: diagnosticState(current),
    })}`;
  }
  return null;
}

async function assertPageContract(page, baseline, requiredSelectors, expectedUrl, phase) {
  const binding = protectedNavContractHandles.get(baseline);
  const projected = baseline.forbiddenState.some(({signatures}) =>
    signatures.some((signature) => signature.nativeSlotProjection));
  if (projected && (!binding || binding.page !== page)) {
    throw new Error(`${phase} protected nav baseline identity is unavailable or belongs to another page`);
  }
  const state = await page.evaluate(readPageContractStateInPage, {
    baselineState: baseline, required: requiredSelectors, url: expectedUrl,
    ...(binding ? {navIdentity: binding.handle} : {}),
  });

  const errors = [];
  if (!state.urlUnchanged) errors.push(`URL 已变化：${page.url()}`);
  if (!state.documentHealthy) errors.push('document/body 已失效');
  for (const current of state.requiredState) {
    const initial = baseline.requiredState.find(({selector}) => selector === current.selector);
    if (!current.exists || current.count < initial.minimumCount) {
      errors.push(`关键 selector 丢失：${current.selector}（${current.count}/${initial.minimumCount}）`);
    }
  }
  for (const current of state.forbiddenState) {
    const initial = baseline.forbiddenState.find(({selector}) => selector === current.selector);
    const error = reconcileForbiddenContractState(initial, current);
    if (error) errors.push(error);
  }
  for (const current of state.interactionState) {
    const initial = baseline.interactionState.find(({selector}) => selector === current.selector);
    const stable = current.count >= initial.minimumCount && current.tagName === initial.tagName &&
      interactionHrefsEquivalent(initial.href, current.href, expectedUrl) && current.type === initial.type && current.disabled === initial.disabled &&
      current.ariaDisabled === initial.ariaDisabled && current.role === initial.role && current.connected &&
      (current.disabled || current.focusable);
    if (!stable) errors.push(`交互元素失效：${JSON.stringify({before: initial, after: current})}`);
  }
  if (errors.length > 0) throw new Error(`${phase} 页面完整性断言失败：${errors.join('；')}`);
  return state;
}

async function assertRequiredRestored(page, baseline, phase) {
  const restored = await page.evaluate((requiredState) => requiredState.map(({selector}) => {
    const snapshotDocument = document.cloneNode(false);
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const semanticSnapshot = (node) => {
      if (!node) return {sourceText: '', structure: ''};
      const clone = snapshotDocument.importNode(node, true);
      clone.querySelectorAll(
        '.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, [data-fr-translation-owned="true"]',
      ).forEach((owned) => owned.remove());
      clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => {
        segment.replaceWith(...segment.childNodes);
      });
      const visit = (current) => {
        if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.nodeValue) ? '#text' : null;
        if (current.nodeType !== Node.ELEMENT_NODE) return null;
        return [current.tagName.toLowerCase(), [...current.childNodes].map(visit).filter(Boolean)];
      };
      return {sourceText: normalizeText(clone.textContent), structure: JSON.stringify(visit(clone))};
    };
    const node = [...document.querySelectorAll(selector)].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && Boolean(candidate.textContent?.trim());
    });
    return {selector, ...semanticSnapshot(node)};
  }), baseline.requiredState);
  const expected = baseline.requiredState.map(({selector, sourceText, structure}) => ({selector, sourceText, structure}));
  if (JSON.stringify(restored) !== JSON.stringify(expected)) {
    throw new Error(`${phase} 未恢复原始文本/结构：${JSON.stringify({expected, restored})}`);
  }
}

async function assertWrapperUniqueness(page, expectedTotal, phase) {
  const state = await page.evaluate(() => {
    const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
    const parentCounts = new Map();
    for (const wrapper of wrappers) {
      parentCounts.set(wrapper.parentElement, (parentCounts.get(wrapper.parentElement) || 0) + 1);
    }
    return {
      total: wrappers.length,
      duplicateParents: [...parentCounts.values()].filter((count) => count > 1).length,
      nested: document.querySelectorAll('.fluent-read-bilingual-content .fluent-read-bilingual-content').length,
    };
  });
  if ((expectedTotal !== null && state.total !== expectedTotal) || state.duplicateParents !== 0 || state.nested !== 0) {
    throw new Error(`${phase} 出现缺失或重复 wrapper：${JSON.stringify({...state, expectedTotal})}`);
  }
  return state;
}

async function readTargetState(page, selector) {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    const wrappers = [...(target?.querySelectorAll('.fluent-read-bilingual-content') || [])];
    return {
      exists: Boolean(target),
      text: target?.textContent?.trim() || '',
      bilingualCount: wrappers.length,
      translationTexts: wrappers.map((wrapper) => wrapper.textContent?.trim() || ''),
    };
  }, selector);
}

// 长页会在滚动结束后继续处理已排队任务。等待“没有完成进展”超时，
// 同时保留阶段硬上限；动画、同一 owner 的 spinner 重建不能延长等待。
function observeTranslationIdleInPage({selector, key, stableMs, stallTimeoutMs, maximumDurationMs}) {
  const now = performance.now();
  const loadingOwners = new Set();
  for (const spinner of document.querySelectorAll(selector)) {
    const owner = spinner.parentElement;
    if (!owner) continue;
    loadingOwners.add(owner);
  }
  const translatedCount = document.querySelectorAll('.fluent-read-bilingual-content[data-fr-translation-owned="true"]').length;
  const state = window[key] || (window[key] = {
    startedAt: now,
    lastProgressAt: now,
    idleSince: null,
    translatedHighWater: translatedCount,
    previousOwners: new Set(),
    completedOwners: new WeakSet(),
  });
  let progressed = translatedCount > state.translatedHighWater;
  state.translatedHighWater = Math.max(state.translatedHighWater, translatedCount);
  for (const owner of state.previousOwners) {
    if (owner.isConnected && !owner.querySelector(selector) && !loadingOwners.has(owner) &&
        !state.completedOwners.has(owner)) {
      state.completedOwners.add(owner);
      progressed = true;
    }
  }
  state.previousOwners = loadingOwners;
  if (progressed) state.lastProgressAt = now;
  if (now - state.startedAt >= maximumDurationMs) {
    throw new Error(`翻译阶段超过 ${maximumDurationMs}ms 硬上限`);
  }
  if (loadingOwners.size === 0) {
    if (state.idleSince === null) state.idleSince = now;
    if (now - state.idleSince >= stableMs) return true;
  } else {
    state.idleSince = null;
    if (now - state.lastProgressAt >= stallTimeoutMs) {
      throw new Error(`翻译连续 ${stallTimeoutMs}ms 没有完成进展（仍有 ${loadingOwners.size} 个加载目标）`);
    }
  }
  return false;
}

async function waitForTranslationIdle(page, timeout, phase, minimumRetryBudget = 210000) {
  const ownedLoading = '.fluent-read-loading[data-fr-translation-owned="true"]';
  const ownedRetry = '.fluent-read-retry-wrapper[data-fr-translation-owned="true"]';
  const idleKey = `__fluentReadIdleSince${Date.now()}${Math.random().toString(36).slice(2)}`;
  // 单个任务允许 provider 重试；整批任务只要持续完成就不误判为卡死。
  const idleTimeout = Math.max(timeout, minimumRetryBudget);
  const maximumDurationMs = idleTimeout * 3;
  try {
    await page.waitForFunction(
      observeTranslationIdleInPage,
      {selector: ownedLoading, key: idleKey, stableMs: 1200, stallTimeoutMs: idleTimeout, maximumDurationMs},
      {timeout: maximumDurationMs + 1000, polling: 100},
    );
  } catch (error) {
    // 失败时先传播原 wait 错误；owner 取证由 main 的共享两秒 collector 负责。
    // 已失去响应的页面不能让无预算 evaluate 阻止错误传播或替换其 cause。
    throw new Error(`${phase} 等待翻译请求结束超时：${error?.message || String(error)}`, {cause: error});
  } finally {
    // context finally 是最终清理边界；迟到或拒绝的 key 删除不阻塞失败传播。
    if (!pageFocusGuards.get(page)?.failure) void Promise.resolve().then(() => {
      assertPageFocusAllowed(page); return page.evaluate((key) => { delete window[key]; }, idleKey);
    }).catch(() => {});
  }

  assertPageFocusAllowed(page);
  const retries = await page.evaluate((selector) => {
    const notices = () => [...(document.querySelector('#fluent-read-page-notice-host')?.shadowRoot
      ?.querySelectorAll('.page-notice') || [])];
    const text = (notice) => (notice.querySelector('.notice-detail')?.textContent || '').trim();
    return [...document.querySelectorAll(selector)].map((node) => {
      const before = new Map(notices().map((notice) => [notice, {
        text: text(notice), leaving: notice.classList.contains('is-leaving'),
      }]));
      const action = node.querySelector('.fluent-read-reason');
      action?.click();
      const active = notices().filter((notice) => !notice.classList.contains('is-leaving'));
      const changed = active.filter((notice) => !before.has(notice)
        || before.get(notice).text !== text(notice) || before.get(notice).leaving);
      // 仅凭唯一旧通知不能证明当前 action 的归属；无可观察更新时保留失败 owner，但不填原因。
      const notice = action && changed.length === 1 ? changed[0] : undefined;
      return {
        ownerTag: node.parentElement?.tagName || '',
        ownerId: node.parentElement?.id || '',
        ownerClass: typeof node.parentElement?.className === 'string' ? node.parentElement.className : '',
        ownerText: (node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 240),
        errorReason: notice ? text(notice).slice(0, 400) : '',
        errorReasonStatus: !action ? 'missing-action' : notice ? 'observed-update'
          : active.length ? 'ambiguous' : 'missing-notice',
      };
    });
  }, ownedRetry);
  if (retries.length > 0) throw new Error(`${phase} 存在终态翻译失败：${JSON.stringify(retries)}`);
}

// 全文翻译使用可视区懒加载。回归时主动滚过页面，触发所有长页面内容块，
// 然后等待插件的进行中任务和 loading 节点都清空，避免只验证到首屏。
async function scrollAndWaitFullPage(page, timeout, scrollContainerSelector, targetSelector, verifyUnchanged, waitForTarget) {
  // Work scales with the observed page geometry; each step still exposes at most 65%
  // of a viewport. An independent cap bounds infinite feeds, and no-progress detection
  // catches blocked scrolling without spending the whole finite-page budget.
  let maxSteps = 320;
  const absoluteMaxSteps = 2048;
  const stepSizeFor = state => Math.max(Math.floor(state.viewport * 0.65), 320);
  const updateStepBudget = state => {
    maxSteps = Math.min(absoluteMaxSteps, Math.max(maxSteps, Math.ceil(state.maxDistance / stepSizeFor(state)) + 8));
  };
  const readScrollState = () => page.evaluate((selector) => {
    const container = selector ? document.querySelector(selector) : null;
    if (selector && !(container instanceof HTMLElement)) {
      throw new Error(`找不到滚动容器：${selector}`);
    }
    // The body can extend outside a clipped root without enlarging the window's
    // scroll range. Read the actual scrolling element, including its scrollbar-adjusted
    // client height, so success and no-progress failures refer to the surface we move.
    const scrolling = container instanceof HTMLElement ? container : document.scrollingElement || document.documentElement;
    const viewport = container instanceof HTMLElement ? Math.max(container.clientHeight, 1)
      : Math.max(scrolling?.clientHeight || window.innerHeight || 0, 1);
    const extent = scrolling?.scrollHeight || viewport;
    return {
      viewport,
      extent,
      position: scrolling?.scrollTop ?? window.scrollY,
      maxDistance: Math.max(0, extent - viewport),
    };
  }, scrollContainerSelector || '');
  const moveTo = (position) => {assertPageFocusAllowed(page); return page.evaluate(({position: nextPosition, selector}) => {
      const container = selector ? document.querySelector(selector) : null;
      if (container instanceof HTMLElement) {
        container.scrollTop = nextPosition;
        return;
      }
      window.scrollTo({top: nextPosition, behavior: 'instant'});
    }, {position, selector: scrollContainerSelector || ''});};

  await moveTo(0);
  await page.waitForTimeout(400);
  await observeCoverage(page);

  let step = 0;
  let bottomStableChecks = 0;
  let lastBottomExtent = -1;
  let previousPosition = -1;
  let stalledChecks = 0;
  while (bottomStableChecks < 2) {
    const before = await readScrollState();
    updateStepBudget(before);
    if (step >= maxSteps) break;
    const remaining = Math.max(0, before.maxDistance - before.position);
    stalledChecks = remaining > 4 && before.position <= previousPosition ? stalledChecks + 1 : 0;
    previousPosition = before.position;
    if (stalledChecks >= 12) throw new Error(`全文翻译连续 ${stalledChecks} 次没有滚动进展：${JSON.stringify(before)}`);
    if (remaining <= 4) {
      await page.waitForTimeout(400);
      await observeCoverage(page);
      const after = await readScrollState();
      const stillAtBottom = after.maxDistance - after.position <= 4;
      const extentStable = Math.abs(after.extent - lastBottomExtent) <= 2;
      bottomStableChecks = stillAtBottom && extentStable ? bottomStableChecks + 1 : 0;
      lastBottomExtent = after.extent;
      if (!stillAtBottom) {
        const stepSize = stepSizeFor(after);
        await moveTo(Math.min(after.maxDistance, after.position + stepSize));
      }
    } else {
      bottomStableChecks = 0;
      lastBottomExtent = -1;
      const stepSize = stepSizeFor(before);
      await moveTo(Math.min(before.maxDistance, before.position + stepSize));
      await page.waitForTimeout(400);
      await observeCoverage(page);
    }
    step += 1;
    if (step % 10 === 0) {
      const current = await readScrollState();
      reportProgress(`全文滚动 ${step} 步，位置 ${Math.round(current.position)}/${Math.round(current.maxDistance)}`);
    }
  }

  if (bottomStableChecks < 2) {
    const current = await readScrollState();
    throw new Error(`全文滚动在 ${maxSteps} 步内未覆盖到底部：${JSON.stringify(current)}`);
  }

  await waitForTranslationIdle(page, timeout, '页面滚动后');

  // 最后一批译文会继续拉高长页面；队列稳定后若底部又向后移动，必须补扫，
  // 不能像旧的固定 40 个比例点那样跨过从未进入 IO 的区段。
  for (let round = 0; round < 3; round += 1) {
    let current = await readScrollState();
    if (current.maxDistance - current.position <= 4) break;
    let catchUpSteps = 0;
    updateStepBudget(current);
    while (catchUpSteps < maxSteps && current.maxDistance - current.position > 4) {
      const stepSize = stepSizeFor(current);
      await moveTo(Math.min(current.maxDistance, current.position + stepSize));
      await page.waitForTimeout(400);
      await observeCoverage(page);
      catchUpSteps += 1;
      current = await readScrollState();
    }
    if (catchUpSteps >= maxSteps && current.maxDistance - current.position > 4) {
      throw new Error('全文翻译后页面持续增长，补扫未能在预算内到达底部');
    }
    await waitForTranslationIdle(page, timeout, `长页补扫第 ${round + 1} 轮后`);
  }
  const finalBottom = await readScrollState();
  if (finalBottom.maxDistance - finalBottom.position > 4) {
    throw new Error(`全文翻译后页面仍未覆盖到底部：${JSON.stringify(finalBottom)}`);
  }

  await settleCoverageByReveal(page, timeout, '全文覆盖收敛', 0, verifyUnchanged);

  await page.waitForTimeout(800);
  assertPageFocusAllowed(page);
  await page.evaluate((selector) => {
    const container = selector ? document.querySelector(selector) : null;
    if (container instanceof HTMLElement) container.scrollTop = 0;
    else window.scrollTo(0, 0);
  }, scrollContainerSelector || '');

  // 返回首屏会启动新一轮 IntersectionObserver。读取状态前重新暴露目标并等待新的
  // 延迟任务，否则有效的中间状态会被误判为译文丢失。
  await revealFullPageTarget(page, targetSelector);
  await waitForTarget();
  await waitForTranslationIdle(page, timeout, '回到目标后');
  await observeCoverage(page);
  await page.waitForTimeout(300);
}

async function revealFullPageTarget(page, selector) {
  const target = page.locator(selector).first();
  try {
    assertPageFocusAllowed(page);
    await target.scrollIntoViewIfNeeded({timeout: 10000});
  } catch {
    assertPageFocusAllowed(page);
    // GitHub 的虚拟化 React 列表可能让已连接且可读的元素暂时处于不可操作状态。
    // 此处直接滚动 DOM 即可；所有翻译输入仍使用可信键盘事件，而不是页面合成事件。
    await target.evaluate((node) => node.scrollIntoView({block: 'center', inline: 'nearest'}));
  }
  // 某些站点会在最近滚动容器移动后的 IntersectionObserver 回调中移除隐藏动画标记。
  await page.waitForTimeout(900);
}

async function readFullPageState(page, selector, requiredSelectors, fullCoverageSelectors, controlSelector) {
  return page.evaluate(({targetSelector, required, coverageSelectors, buttonSelector}) => {
    const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
    const parents = new Set(wrappers.map((wrapper) => wrapper.parentElement));
    const target = document.querySelector(targetSelector);
    const requiredBilingual = required.map((requiredSelector) => {
      const node = [...document.querySelectorAll(requiredSelector)].find((candidate) => {
        if (candidate.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(candidate.textContent?.trim());
      });
      const translations = [...(node?.querySelectorAll('.fluent-read-bilingual-content') || [])];
      return {
        selector: requiredSelector,
        index: node ? [...document.querySelectorAll(requiredSelector)].indexOf(node) : -1,
        exists: Boolean(node),
        bilingualCount: translations.length,
        translationTexts: translations.map((translation) => translation.textContent?.trim() || ''),
      };
    });
    const fullCoverage = coverageSelectors.map((coverageSelector) => {
      const nodes = [...document.querySelectorAll(coverageSelector)].filter((candidate) => {
        if (candidate.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(candidate.textContent?.trim());
      });
      const translated = nodes.filter((node) => {
        const translations = [...node.querySelectorAll('.fluent-read-bilingual-content')];
        return translations.length > 0 &&
          translations.every((translation) => /[\u3400-\u9fff]/u.test(translation.textContent || ''));
      });
      return {selector: coverageSelector, visibleCount: nodes.length, translatedCount: translated.length};
    });
    return {
      totalBilingual: wrappers.length,
      uniqueWrapperParents: parents.size,
      targetBilingual: target?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
      requiredBilingual,
      fullCoverage,
      controlTexts: buttonSelector
        ? [...document.querySelectorAll(buttonSelector)].map((node) => node.textContent?.trim() || '')
        : [],
    };
  }, {
    targetSelector: selector,
    required: requiredSelectors,
    coverageSelectors: fullCoverageSelectors,
    buttonSelector: controlSelector || '',
  });
}

function findHoverTextPointInPage({selector, index, textIncludes = []}) {
  const target = document.querySelectorAll(selector)[index];
  if (!target?.isConnected) return null;
  const excluded = '[data-fr-translation-owned="true"], .fluent-read-bilingual-content, ' +
    '.fluent-read-loading, .fluent-read-retry-wrapper, [hidden], [aria-hidden="true"], [inert]';
  const hitPolicyForText = (parent, x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (!hit.closest(excluded) && target.contains(hit) && (hit === parent || hit.contains(parent))) return 'direct-text';
    // Google News /home 的空整卡链接与可读标题是同一卡片的兄弟。
    // 只接受已观察到的三层命中栈；aria-hidden 的例外只属于这个空链接自身。
    if (typeof location !== 'undefined' && location.hostname === 'news.google.com' && location.pathname === '/home' &&
      parent === target && target.matches('main a[href^="./read/"]:not([aria-hidden="true"])')) {
      const wrapper = hit.parentElement;
      const headlineParent = target.parentElement;
      const contentShell = headlineParent?.parentElement;
      // 当前公开页也会在同一卡片的首个空链接与标题之间嵌两层正文容器。
      // 精确验证已观察的父子/相邻关系及标题唯一性，不向任意祖先或其它卡片穿透。
      const nestedCard = contentShell?.parentElement;
      const nested = Boolean(wrapper && headlineParent && contentShell && nestedCard &&
        wrapper.parentElement === nestedCard && wrapper.nextElementSibling === contentShell &&
        contentShell.children.length === 1 && contentShell.firstElementChild === headlineParent &&
        headlineParent.lastElementChild === target &&
        nestedCard.querySelectorAll('a[href^="./read/"]:not([aria-hidden="true"])').length === 1 &&
        nestedCard.querySelector('a[href^="./read/"]:not([aria-hidden="true"])') === target);
      const card = nested ? nestedCard : headlineParent;
      const barrier = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], button, [role="button"], ' +
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]';
      const nonAriaExcluded = '[data-fr-translation-owned="true"], .fluent-read-bilingual-content, ' +
        '.fluent-read-loading, .fluent-read-retry-wrapper, [hidden], [inert]';
      const href = target.getAttribute('href');
      const destination = target.getAttribute('target');
      const stack = document.elementsFromPoint?.(x, y);
      if (!hit.matches('a[aria-hidden="true"][tabindex="-1"]') || hit.childNodes.length ||
        !wrapper?.matches('div') || wrapper.childNodes.length !== 1 || wrapper.firstChild !== hit ||
        !card?.matches('div') || wrapper.parentElement !== card || card.firstElementChild !== wrapper ||
        hit.closest(nonAriaExcluded) || wrapper.closest(excluded) ||
        [hit, wrapper, target].some(owner => owner.closest(barrier)) ||
        !href || hit.getAttribute('href') !== href || destination !== '_blank' || hit.getAttribute('target') !== destination ||
        !stack || stack[0] !== hit || stack[1] !== wrapper || stack[2] !== target) return null;
      const paintlessStretchedBox = owner => {
        try {
          const style = getComputedStyle(owner);
          const transparent = style.backgroundColor === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/u.test(style.backgroundColor);
          return style.position === 'absolute' && ['left', 'right', 'top', 'bottom'].every(key => style[key] === '0px') &&
            transparent && style.backgroundImage === 'none' && style.boxShadow === 'none' && style.filter === 'none' &&
            (!style.backdropFilter || style.backdropFilter === 'none') && style.opacity === '1' &&
            ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'].every(key => style[key] === '0px');
        } catch { return false; }
      };
      if (![hit, wrapper].every(paintlessStretchedBox)) return null;
      // 未出现在命中栈的共同或独立祖先也可能隐藏整张卡片。路径有界、必须到达当前文档根。
      const visiblyConnected = owner => {
        try {
          let current = owner, depth = 0;
          while (current && ++depth <= 128) {
            const style = getComputedStyle(current), opacity = Number(style.opacity);
            if (style.display === 'none' || style.visibility !== 'visible' || !Number.isFinite(opacity) || opacity <= 0) return false;
            if (current === document.documentElement) return true;
            current = current.parentElement;
          }
        } catch { /* 未能读取样式时拒绝该例外。 */ }
        return false;
      };
      if (![hit, target].every(visiblyConnected)) return null;
      for (const owner of new Set([hit, wrapper, target, headlineParent, ...(nested ? [contentShell, card] : [card])])) {
        for (const pseudo of ['::before', '::after']) {
          let content;
          try { content = getComputedStyle(owner, pseudo).content; } catch { return null; }
          if (content !== 'none' && content !== 'normal' && content !== '') return null;
        }
      }
      // 目的地也是稳定性的一部分；同一文字下的链接更新会重置既有 200ms 计时。
      return `google-news-stretched-link:${JSON.stringify([href, destination])}`;
    }
    // Steam 讨论列表在标题上方放置同一行的空白链接；只接受实测的命中栈与主题链接。
    // 普通用户不会点击该链接；仍以标题原文 Range 和真实键盘事件执行悬浮测试。
    if (typeof location !== 'undefined' && location.origin === 'https://steamcommunity.com' &&
      location.pathname === '/app/570/discussions/' && !location.search && !location.hash &&
      parent === target && target.matches('#AppHubContent .forum_topics > .forum_topic > .forum_topic_name')) {
      const row = target.parentElement;
      const overlays = [...row.children].filter(child => child.matches('a.forum_topic_overlay'));
      const stack = document.elementsFromPoint?.(x, y);
      const barrier = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], button, [role="button"], ' +
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]';
      const topicId = row.getAttribute('data-gidforumtopic');
      const href = hit.getAttribute('href');
      if (!row.matches('div.forum_topic[role="button"]') ||
        row.matches('[aria-modal="true"], [contenteditable]:not([contenteditable="false"])') ||
        !hit.matches('a.forum_topic_overlay') || hit.parentElement !== row || overlays.length !== 1 || overlays[0] !== hit ||
        [...hit.childNodes].some(node => node.nodeType !== 3 || node.textContent?.trim()) ||
        hit.closest(excluded) || hit.closest(barrier) !== row || target.closest(barrier) !== row ||
        row.parentElement?.closest(barrier) || !topicId || !/^\d+$/u.test(topicId) || !href ||
        !stack || stack[0] !== hit || stack[1] !== target || stack[2] !== row) return null;
      let link;
      try { link = new URL(href, location.href); } catch { return null; }
      if (link.origin !== location.origin || link.search || link.hash ||
        !new RegExp(`^/app/570/discussions/\\d+/${topicId}/?$`, 'u').test(link.pathname)) return null;
      const style = getComputedStyle(hit);
      const transparent = style.backgroundColor === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/u.test(style.backgroundColor);
      if (style.position !== 'absolute' || style.display === 'none' || style.visibility !== 'visible' ||
        style.pointerEvents === 'none' || style.opacity !== '1' || !transparent || style.backgroundImage !== 'none' ||
        style.boxShadow !== 'none' || style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none') ||
        !['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'].every(key => style[key] === '0px')) return null;
      for (const owner of [hit, target, row]) {
        for (const pseudo of ['::before', '::after']) {
          const content = getComputedStyle(owner, pseudo).content;
          if (content !== 'none' && content !== 'normal' && content !== '') return null;
        }
      }
      return `steam-community-topic-overlay:${JSON.stringify([href, topicId])}`;
    }
    if (hit.closest(excluded)) return null;
    // PH 首页把产品名链接的空 span 拉伸到整张卡片。仅识别已观察到的结构，
    // 且命中栈第二项必须是当前介绍的原文 parent，不能穿过其他遮罩或控件。
    if (typeof location === 'undefined' || location.hostname !== 'www.producthunt.com' || location.pathname !== '/' ||
      parent !== target || !target.matches('main [data-test^="homepage-section-"] > section[data-container] > div > span:nth-of-type(2)')) return null;
    const barrier = 'dialog, [role="dialog"], [role="alertdialog"], button, [role="button"], input, textarea, select, [contenteditable="true"]';
    if (hit.closest(barrier) || parent.closest(barrier) || !hit.matches('a > span[data-target="true"]') || hit.childNodes.length) return null;
    const link = hit.parentElement;
    const title = link?.parentElement;
    const section = target.closest('section[data-container]');
    if (!section || hit.closest('section[data-container]') !== section ||
      !link.getAttribute('href')?.startsWith('/products/') || title !== target.previousElementSibling ||
      title.parentElement !== target.parentElement || !title.matches('span:first-of-type')) return null;
    const stack = document.elementsFromPoint?.(x, y);
    if (!stack || stack[0] !== hit || stack[1] !== parent) return null;
    const style = getComputedStyle(hit);
    const transparent = style.backgroundColor === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/u.test(style.backgroundColor);
    if (style.position !== 'absolute' || !['left', 'right', 'top', 'bottom'].every(key => style[key] === '0px') ||
      !transparent || style.backgroundImage !== 'none' || style.boxShadow !== 'none' ||
      style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none') ||
      !['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'].every(key => style[key] === '0px')) return null;
    for (const owner of [hit, link, title]) {
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(owner, pseudo).content;
        if (content !== 'none' && content !== 'normal' && content !== '') return null;
      }
    }
    return 'product-hunt-stretched-link';
  };
  const walker = document.createTreeWalker(target, 4);
  const candidates = [];
  let textNode;
  let textIndex = 0;
  while ((textNode = walker.nextNode())) {
    const currentIndex = textIndex++;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(excluded) || !textNode.textContent?.trim()) continue;
    const originalText = textNode.textContent.replace(/\s+/gu, ' ').trim();
    if (!textIncludes.every(fragment => originalText.includes(fragment))) continue;
    let style;
    try { style = getComputedStyle(parent); } catch { continue; }
    if (!style) continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    for (const rect of range.getClientRects()) {
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      const x = left + (right - left) * 0.35;
      const y = top + (bottom - top) / 2;
      const hitPolicy = hitPolicyForText(parent, x, y);
      if (!hitPolicy) continue;
      // 优先原文普通文本，避免把标题末尾的永久链接或双语副本当作手势入口。
      const link = parent.closest('a');
      candidates.push({
        x, y, textIndex: currentIndex, hitPolicy,
        text: textNode.textContent,
        rect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height},
        priority: link && link !== target ? 1 : 0,
      });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority);
  return candidates[0] || null;
}

async function waitForHoverPointer(page, targetConfig, timeout, prepareClickText) {
  const started = Date.now();
  let previous;
  let stableSince = started;
  let prepared = false;
  while (Date.now() - started < timeout) {
    // 每轮都用同一原文 Range / 命中栈判定复核，移动鼠标触发的遮罩也会重置稳定期。
    const point = await page.evaluate(findHoverTextPointInPage, targetConfig);
    // Cookie 面板可能在首次页面准备结束后出现。只复核 case 已声明的准备按钮，
    // 原文 Range 无法命中时用可信点击关闭；不点击可折叠标题，也不退回标题外框。
    if (!point && prepareClickText && !prepared) {
      const button = page.getByText(prepareClickText, {exact: true}).filter({visible: true}).last();
      if (await button.isVisible()) {
        const clickBudget = timeout - (Date.now() - started);
        if (clickBudget <= 0) break;
        prepared = true;
        assertPageFocusAllowed(page);
        await button.click({timeout: clickBudget});
        const hideBudget = timeout - (Date.now() - started);
        if (hideBudget <= 0) break;
        await button.waitFor({state: 'hidden', timeout: hideBudget});
        previous = null;
        stableSince = Date.now();
        continue;
      }
    }
    const stable = point && previous && point.textIndex === previous.textIndex && point.text === previous.text &&
      point.hitPolicy === previous.hitPolicy &&
      ['left', 'top', 'width', 'height'].every((key) => Math.abs(point.rect[key] - previous.rect[key]) < 0.5) &&
      Math.abs(point.x - previous.x) < 0.5 && Math.abs(point.y - previous.y) < 0.5;
    if (!stable) {
      stableSince = Date.now();
      if (point) {assertPageFocusAllowed(page); await page.mouse.move(point.x, point.y);}
    } else if (Date.now() - stableSince >= 200) {
      return point;
    }
    previous = point;
    await page.waitForTimeout(50);
  }
  const pointerRecheck = await page.evaluate(findHoverTextPointInPage, targetConfig);
  const targetState = await page.evaluate(({selector, index}) => {
    const node = document.querySelectorAll(selector)[index];
    const rect = node?.getBoundingClientRect();
    const sample = [...(node?.childNodes || [])].slice(0, 6).map(child => ({
      type: child.nodeType, text: child.textContent?.trim().slice(0, 100),
      tag: child.nodeType === 1 ? child.tagName : null,
    }));
    const hitX = rect ? Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width * 0.35)) : 0;
    const hitY = rect ? Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)) : 0;
    const hitStack = document.elementsFromPoint(hitX, hitY).slice(0, 6).map(element => ({
      tag: element.tagName, id: element.id, className: String(element.className).slice(0, 140),
    }));
    // 外框命中不能证明文字未被遮挡；失败时记录实际嵌套原文的 Range 与命中元素。
    const textRangeSamples = [];
    if (node) {
      const excluded = '[data-fr-translation-owned="true"], .fluent-read-bilingual-content, ' +
        '.fluent-read-loading, .fluent-read-retry-wrapper, [hidden], [aria-hidden="true"], [inert]';
      const walker = document.createTreeWalker(node, 4);
      let textNode;
      while (textRangeSamples.length < 8 && (textNode = walker.nextNode())) {
        const parent = textNode.parentElement;
        if (!parent || !textNode.textContent?.trim()) continue;
        const style = getComputedStyle(parent);
        const range = document.createRange();
        range.selectNodeContents(textNode);
        textRangeSamples.push({
          text: textNode.textContent.slice(0, 120), parentTag: parent.tagName,
          excluded: Boolean(parent.closest(excluded)), display: style.display, visibility: style.visibility,
          rects: [...range.getClientRects()].slice(0, 4).map(rect => {
            const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
            const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
            const x = left + (right - left) * 0.35, y = top + (bottom - top) / 2;
            const hit = document.elementFromPoint(x, y);
            return {left: rect.left, top: rect.top, width: rect.width, height: rect.height, x, y,
              clippedWidth: right - left, clippedHeight: bottom - top,
              hit: hit && {tag: hit.tagName, className: String(hit.className).slice(0, 140),
                insideTarget: node.contains(hit), excluded: Boolean(hit.closest(excluded)),
                containsTextParent: hit === parent || hit.contains(parent)}};
          }),
        });
      }
    }
    return {html: node?.outerHTML.slice(0, 900), rect: rect && {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
      viewport: {width: innerWidth, height: innerHeight}, sample, hitStack, textRangeSamples,
      listSamples: [...document.querySelectorAll('main li')].slice(0, 40).map(item => ({
        text: item.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 90),
        className: item.className,
        parentClass: item.parentElement?.className,
      }))};
  }, targetConfig);
  throw new Error(`悬浮原文没有稳定且可命中的位置：${JSON.stringify({targetConfig, lastPoint: previous, pointerRecheck, targetState,
    preparation: {text: prepareClickText || '', clicked: prepared}})}`);
}

async function toggleHover(page, target, targetConfig, expectedCount, timeout, attempt, prepareClickText) {
  const {selector, index} = targetConfig;
  assertPageFocusAllowed(page); await target.scrollIntoViewIfNeeded();
  // viewport 内的原文仍可能被原生 sticky 标题遮住。先用原生滚动居中，
  // 再由下面原有的 TextRange / 实际命中 / 稳定期门禁决定能否发送手势。
  assertPageFocusAllowed(page); await target.evaluate((node) => node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}));
  // 还原译文会改变布局，宿主也可能继续滚动或播放入场动画。固定等待后取外框
  // 坐标会落到空白容器；按键前等待真实原文行稳定并保持命中，按键只发送一次。
  const point = await waitForHoverPointer(page, targetConfig, timeout, prepareClickText);
  const {x, y} = point;
  assertPageFocusAllowed(page); await page.keyboard.down('Control');
  assertPageFocusAllowed(page); await page.keyboard.up('Control');
  try {
    await page.waitForFunction(
      ({targetSelector, targetIndex, count}) =>
        (document.querySelectorAll(targetSelector)[targetIndex]
          ?.querySelectorAll('.fluent-read-bilingual-content').length || 0) === count,
      {targetSelector: selector, targetIndex: index, count: expectedCount},
      {timeout},
    );
  } catch (error) {
    const diagnostics = await page.evaluate(({targetSelector, targetIndex, point}) => {
      const target = document.querySelectorAll(targetSelector)[targetIndex];
      return {
        url: location.href,
        text: target?.textContent?.trim() || '',
        bilingualCount: target?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
        loadingCount: target?.querySelectorAll('.fluent-read-loading').length || 0,
        retryCount: target?.querySelectorAll('.fluent-read-retry-wrapper').length || 0,
        hitStack: document.elementsFromPoint(point.x, point.y).slice(0, 8).map((element) => ({
          tag: element.tagName,
          id: element.id,
          className: typeof element.className === 'string' ? element.className : '',
          text: (element.textContent || '').trim().slice(0, 120),
        })),
        translatedParents: [...document.querySelectorAll('.fluent-read-bilingual-content')].map((wrapper) =>
          (wrapper.parentElement?.textContent || '').trim().slice(0, 160)),
      };
    }, {targetSelector: selector, targetIndex: index, point: {x, y}});
    throw new Error(`${error.message}\n悬浮 case 诊断（${JSON.stringify(targetConfig)}，第 ${attempt} 次，期望 wrapper=${expectedCount}）：${JSON.stringify(diagnostics)}`);
  }
  return point;
}

function findHoverTargetInPage({
  selector,
  eligibleIndex,
  sourceIncludes,
  excludedSelector,
  protectedSelector,
  nonDialogExcludedSelector,
  readingPostDialog,
  technicalWords,
}) {
  const snapshotDocument = document.cloneNode(false);
  const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
  const technicalWordSet = new Set(technicalWords);
  const naturalLanguage = (text) => {
    if (/^https?:\/\/\S+$/iu.test(text)) return false;
    if (!text || /^#!|^#lang\b|^<!doctype\b|^<\?xml\b/iu.test(text)) return false;
    if (/^[a-z][a-z0-9_-]*(?:-stmt|-expr|-clause)?:\s*(?:hide|show|expand|collapse|藏起来)?$/iu.test(text)) {
      return false;
    }
    const token = text.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/gu, '');
    if (!/\s/u.test(token) && (technicalWordSet.has(token.toLowerCase()) ||
      (/^[A-Z][A-Z0-9_-]{3,15}$/u.test(token) && !/[AEIOU]/u.test(token)))) return false;
    const letters = text.match(/[A-Za-z]/gu)?.length || 0;
    const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
    return letters >= 2 && letters >= cjk;
  };
  const sourceText = (node) => {
    const clone = snapshotDocument.importNode(node, true);
    clone.querySelectorAll(
      `.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, ` +
      `[data-fr-translation-owned="true"], ${protectedSelector}`,
    ).forEach((protectedNode) => protectedNode.remove());
    return normalizeText(clone.textContent);
  };
  const raw = [...document.querySelectorAll(selector)];
  const matches = raw.map((node, rawIndex) => ({node, rawIndex, text: sourceText(node)})).filter(({node, text}) => {
    if (!(node instanceof HTMLElement)) return false;
    if (readingPostDialog && (!readingPostDialog.isConnected ||
        !readingPostDialog.matches('[role="dialog"][aria-modal="true"]') || !readingPostDialog.contains(node))) return false;
    let ancestor = node.closest(excludedSelector);
    while (ancestor && ancestor === readingPostDialog && !ancestor.matches(nonDialogExcludedSelector)) {
      ancestor = ancestor.parentElement?.closest(excludedSelector) || null;
    }
    if (ancestor) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
      // This positive hover flow requires a Chinese output; choose a source without Han
      // rather than a Chinese title whose commit prefix or code names inflate Latin counts.
      naturalLanguage(text) && !/[\u3400-\u9fff]/u.test(text) &&
      sourceIncludes.every((fragment) => text.includes(fragment));
  });
  const result = matches[eligibleIndex] || null;
  return result ? {rawIndex: result.rawIndex, sourceText: result.text} : null;
}

async function resolveHoverTarget(page, targetConfig, timeout) {
  const argument = {
    selector: targetConfig.selector,
    eligibleIndex: targetConfig.index,
    sourceIncludes: targetConfig.sourceIncludes || [],
    ...coverageEligibilityContext(page),
    technicalWords: [...SINGLE_TOKEN_TECHNICAL_WORDS],
  };
  await page.waitForFunction(findHoverTargetInPage, argument, {timeout});
  const resolved = await page.evaluate(findHoverTargetInPage, argument);
  if (!resolved) throw new Error(`找不到 eligible 悬浮目标：${JSON.stringify(targetConfig)}`);
  return {
    config: {...targetConfig, index: resolved.rawIndex},
    requestedEligibleIndex: targetConfig.index,
    rawIndex: resolved.rawIndex,
    sourceText: resolved.sourceText,
  };
}

async function toggleFull(page) {
  // 全文翻译使用产品真实快捷键 Alt+T，而不是点击浮球或构造 KeyboardEvent。
  assertPageFocusAllowed(page); await page.keyboard.down('Alt');
  assertPageFocusAllowed(page); await page.keyboard.press('t');
  assertPageFocusAllowed(page); await page.keyboard.up('Alt');
}

async function closeInteractionDialog(page, scenario, timeout, phase) {
  const attemptTimeout = Math.min(timeout, INTERACTION_CLOSE_ATTEMPT_TIMEOUT);
  const waitFailures = [];
  const attemptTimings = [];
  const nodeStamp = () => ({wallMs: Date.now(), monotonicMs: Number(process.hrtime.bigint()) / 1e6});
  let diagnosticState;
  let predicateState = {status: 'unavailable', category: 'state-create-unavailable'};
  try {
    // JSHandle 留在页面执行上下文中；不写宿主 DOM 或 window，也不捕获 Node 侧变量。
    diagnosticState = await page.evaluateHandle(() => ({attempts: []}));
  } catch {
    // 取证不可用时仍执行原等待和全部重试，不把诊断变成关闭条件。
  }
  try {
    for (let attempt = 1; attempt <= scenario.closeAttempts; attempt += 1) {
      const timing = {attempt, start: nodeStamp()};
      attemptTimings.push(timing);
      assertPageFocusAllowed(page); await page.keyboard.press(scenario.closeKey);
      timing.keyDone = nodeStamp();
      try {
        // 检查全部匹配的 dialog 与原 trigger；保留每次时限和真实 Escape 次数。
        timing.beforeWait = nodeStamp();
        await page.waitForFunction(({dialogSelector, triggerSelector, diagnosticState, attempt}) => {
          const browserMono = () => typeof performance === 'object' && typeof performance.now === 'function'
            ? performance.now() : null;
          const sample = {attempt, capturedAt: Date.now(), capturedMonoMs: browserMono(), category: 'predicate-error', stage: 'trigger-query',
            triggerState: null, matchingDialogCount: null, inspectedDialogs: 0, dialogs: []};
          const record = () => {
            sample.recordedAt = Date.now();
            sample.recordedMonoMs = browserMono();
            if (!diagnosticState) return;
            const previous = diagnosticState.attempts[attempt - 1];
            diagnosticState.attempts[attempt - 1] = {
              pollCount: (previous?.pollCount || 0) + 1,
              firstPollAt: previous?.firstPollAt ?? sample.capturedAt,
              firstPollMonoMs: previous?.firstPollMonoMs ?? sample.capturedMonoMs,
              lastPoll: sample,
              lastFalse: sample.category !== 'closed' && sample.category !== 'predicate-error'
                ? sample : previous?.lastFalse || null,
              lastPredicateError: sample.category === 'predicate-error' ? sample : previous?.lastPredicateError || null,
            };
          };
          try {
            const trigger = document.querySelector(triggerSelector);
            sample.stage = 'trigger-state';
            sample.triggerState = {connected: Boolean(trigger?.isConnected),
              ariaExpanded: trigger?.getAttribute('aria-expanded') ?? null};
            if (!sample.triggerState.connected || sample.triggerState.ariaExpanded === 'true') {
              sample.category = sample.triggerState.connected ? 'trigger-expanded' : 'trigger-missing';
              record();
              return false;
            }
            sample.stage = 'dialog-query';
            const dialogs = [...document.querySelectorAll(dialogSelector)];
            sample.matchingDialogCount = dialogs.length;
            const isVisible = (node) => {
              sample.stage = 'dialog-rect';
              const rect = node.getBoundingClientRect();
              sample.stage = 'dialog-style';
              const style = getComputedStyle(node);
              const visible = node.isConnected && rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
              sample.inspectedDialogs += 1;
              // 只限制输出样本；some 仍检查到首个可见节点，不截断关闭断言。
              if (sample.dialogs.length < 8 || visible) sample.dialogs.push({index: sample.inspectedDialogs - 1,
                connected: node.isConnected, width: rect.width, height: rect.height,
                display: style.display, visibility: style.visibility, visible});
              return visible;
            };
            const closed = !dialogs.some(isVisible);
            sample.stage = 'result';
            sample.category = closed ? 'closed' : 'matching-dialog-visible';
            record();
            return closed;
          } catch (error) {
            sample.category = 'predicate-error';
            record();
            throw error;
          }
        }, {
          dialogSelector: scenario.dialogSelector,
          triggerSelector: scenario.triggerSelector,
          diagnosticState: diagnosticState || null,
          attempt,
        }, {timeout: attemptTimeout, polling: 50});
        timing.outcome = 'wait-resolved';
        return attempt;
      } catch (error) {
        timing.outcome = error?.name === 'TimeoutError' ? 'wait-timeout' : 'wait-error';
        waitFailures.push({attempt, category: timing.outcome});
      } finally {
        // 这是调用方收到结果/错误的时间，包含 Playwright 内部的 abort 清理；不是精确 deadline。
        timing.afterWait = nodeStamp();
      }
    }
    if (diagnosticState) {
      try {
        const state = await diagnosticState.evaluate(state => state);
        predicateState = {status: 'available', attempts: waitFailures.map(({attempt}) =>
          state.attempts[attempt - 1] || {pollCount: 0, category: 'no-predicate-sample'})};
      } catch {
        predicateState = {status: 'unavailable', category: 'state-read-unavailable'};
      }
    }
    const dialogState = await page.evaluate(({dialogSelector, triggerSelector}) => {
      const dialog = document.querySelector(dialogSelector);
      const trigger = document.querySelector(triggerSelector);
      const active = document.activeElement;
      return {capturedAt: Date.now(), snapshotPhase: 'after-all-close-attempts',
        triggerState: {connected: Boolean(trigger?.isConnected), ariaExpanded: trigger?.getAttribute('aria-expanded') ?? null},
        dialogVisible: Boolean(dialog?.getBoundingClientRect().width && dialog?.getBoundingClientRect().height),
        dialogText: dialog?.textContent?.trim().slice(0, 300),
        activeElement: active?.outerHTML.slice(0, 400),
        matchingDialogs: [...document.querySelectorAll(dialogSelector)].map(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {html: node.outerHTML.slice(0, 900), connected: node.isConnected,
            width: rect.width, height: rect.height, display: style.display, visibility: style.visibility};
        }),
        openDialogs: [...document.querySelectorAll('[role="dialog"],dialog')]
          .filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height)
          .map(node => ({role: node.getAttribute('role'), label: node.getAttribute('aria-label')}))};
    }, {dialogSelector: scenario.dialogSelector, triggerSelector: scenario.triggerSelector})
      .catch(() => ({status: 'unavailable', category: 'final-snapshot-unavailable'}));
    throw new Error(
      `${phase}/${scenario.name} 对话框在 ${scenario.closeAttempts} 次 ${scenario.closeKey} 后仍未隐藏` +
      `；诊断：${JSON.stringify({...dialogState, closeWait: {attemptTimeout, polling: 50, waitFailures, attemptTimings, predicateState}})}`,
    );
  } finally {
    if (diagnosticState) await diagnosticState.dispose().catch(() => {});
  }
}

async function runInteractionScenarios(page, scenarios, timeout, phase) {
  const results = [];
  for (const scenario of scenarios) {
    await page.waitForSelector(scenario.triggerSelector, {state: 'visible', timeout});
    const initialUrl = page.url();
    const before = await page.locator(scenario.triggerSelector).first().evaluate((node) => ({
      tagName: node.tagName,
      text: (node.textContent || '').replace(/\s+/gu, ' ').trim(),
      ariaLabel: node.getAttribute('aria-label') || '',
      role: node.getAttribute('role') || '',
    }));

    if (scenario.openKey === 'click') {
      assertPageFocusAllowed(page);
      await page.locator(scenario.triggerSelector).first().click();
    } else {
      assertPageFocusAllowed(page);
      await page.keyboard.press(scenario.openKey);
    }
    await page.waitForSelector(scenario.dialogSelector, {state: 'visible', timeout});
    const dialogLocator = page.locator(scenario.dialogSelector).first();
    const comboboxLocator = dialogLocator.locator(scenario.comboboxSelector).first();
    await comboboxLocator.waitFor({state: 'visible', timeout});
    if (scenario.inputText) {assertPageFocusAllowed(page); await comboboxLocator.fill(scenario.inputText);}
    await page.waitForFunction(({dialogSelector, comboboxSelector, listboxSelector, inputText}) => {
      const isVisible = (node) => {
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        return Boolean(node?.isConnected && rect && rect.width > 0 && rect.height > 0 &&
          style?.display !== 'none' && style?.visibility !== 'hidden');
      };
      const dialog = [...document.querySelectorAll(dialogSelector)].find(isVisible);
      const combobox = dialog?.querySelector(comboboxSelector);
      const listbox = dialog?.querySelector(listboxSelector);
      const listboxText = listbox
        ? [listbox.getAttribute('aria-label') || '', listbox.textContent || ''].join(' ').replace(/\s+/gu, ' ').trim()
        : '';
      const value = 'value' in (combobox || {}) ? String(combobox.value) : '';
      return isVisible(combobox) && isVisible(listbox) && (!inputText || value === inputText) &&
        listboxText.length > 0 && listbox.querySelectorAll('[role="option"]').length > 0;
    }, {
      dialogSelector: scenario.dialogSelector,
      comboboxSelector: scenario.comboboxSelector,
      listboxSelector: scenario.listboxSelector,
      inputText: scenario.inputText,
    }, {timeout});
    await waitForTranslationIdle(page, timeout, `${phase}/${scenario.name}`);
    const dialog = await page.locator(scenario.dialogSelector).first().evaluate((node, selectors) => {
      const rect = node.getBoundingClientRect();
      const ownedSelector = [
        '.fluent-read-bilingual-content',
        '.fluent-read-loading',
        '.fluent-read-retry-wrapper',
        '[data-fr-translation-owned="true"]',
      ].join(', ');
      const controls = [...node.querySelectorAll(selectors.combobox)];
      const listboxes = [...node.querySelectorAll(selectors.listbox)];
      const accessibleText = [
        node.textContent || '',
        ...controls.flatMap((control) => [
          control.getAttribute('aria-label') || '',
          control.getAttribute('placeholder') || '',
        ]),
      ].join(' ').replace(/\s+/gu, ' ').trim();
      const combobox = controls[0];
      const listbox = listboxes[0];
      const listboxRect = listbox?.getBoundingClientRect();
      const listboxStyle = listbox ? getComputedStyle(listbox) : null;
      const listboxAccessibleText = listbox
        ? [listbox.getAttribute('aria-label') || '', listbox.textContent || ''].join(' ').replace(/\s+/gu, ' ').trim()
        : '';
      return {
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden',
        ownedCount: node.querySelectorAll(ownedSelector).length,
        controlCount: controls.length,
        listboxCount: listboxes.length,
        comboboxValue: combobox && 'value' in combobox ? String(combobox.value) : '',
        listboxConnected: Boolean(listbox?.isConnected),
        listboxVisible: Boolean(listboxRect && listboxRect.width > 0 && listboxRect.height > 0 &&
          listboxStyle?.display !== 'none' && listboxStyle?.visibility !== 'hidden'),
        listboxAccessibleText,
        optionCount: listbox?.querySelectorAll('[role="option"]').length || 0,
        accessibleText,
      };
    }, {combobox: scenario.comboboxSelector, listbox: scenario.listboxSelector});
    if (!dialog.visible || dialog.controlCount < 1 || dialog.listboxCount < 1 ||
        !dialog.accessibleText || dialog.ownedCount !== 0 ||
        (scenario.inputText && dialog.comboboxValue !== scenario.inputText) ||
        !dialog.listboxConnected || !dialog.listboxVisible || !dialog.listboxAccessibleText ||
        dialog.optionCount < 1) {
      throw new Error(`${phase}/${scenario.name} 受控对话框断言失败：${JSON.stringify(dialog)}`);
    }

    const closeAttemptsUsed = await closeInteractionDialog(page, scenario, timeout, phase);
    const after = await page.locator(scenario.triggerSelector).first().evaluate((node) => ({
      tagName: node.tagName,
      text: (node.textContent || '').replace(/\s+/gu, ' ').trim(),
      ariaLabel: node.getAttribute('aria-label') || '',
      role: node.getAttribute('role') || '',
      connected: node.isConnected,
      visible: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0,
    }));
    const stable = page.url() === initialUrl && after.connected && after.visible &&
      after.tagName === before.tagName && after.text === before.text && after.ariaLabel === before.ariaLabel &&
      after.role === before.role;
    if (!stable) {
      throw new Error(`${phase}/${scenario.name} trigger 未保留：${JSON.stringify({before, after, initialUrl, url: page.url()})}`);
    }
    results.push({name: scenario.name, before, dialog, after, closeAttemptsUsed});
  }
  return results;
}

async function captureEvidence(page, outputPath) {
  try {
    await page.screenshot({path: outputPath, fullPage: false, timeout: 10000, caret: 'initial'});
  } catch (error) {
    process.stderr.write(`证据截图失败（不影响 DOM/交互断言）：${error.message}\n`);
  }
}

async function captureSourcePartitionLedger(page, configs, controlledProvider) {
  const partitions = configs.filter(config => config.sourcePartition);
  if (!partitions.length) return null;
  if (typeof controlledProvider?.captureSourcePartitions !== 'function' ||
      typeof controlledProvider?.assertSourcePartitions !== 'function') {
    throw new Error('sourcePartition 完整正文契约必须使用支持来源 ledger 的 --controlled-provider');
  }
  const ledger = await controlledProvider.captureSourcePartitions(page, partitions);
  if (!ledger || typeof ledger !== 'object') throw new Error('sourcePartition 未捕获有效的原生正文基线 ledger');
  return ledger;
}

async function verifySourcePartitionLedger(page, ledger, controlledProvider, phase, restored = false) {
  if (ledger === null) return undefined;
  if (!ledger || typeof controlledProvider?.assertSourcePartitions !== 'function') {
    throw new Error(`${phase} sourcePartition 原生正文 ledger 或校验器缺失`);
  }
  return controlledProvider.assertSourcePartitions(page, ledger, phase, {restored});
}

async function runHoverCase(page, hoverTargets, requiredSelectors, pageContract, timeout, artifactsDir, prepareClickText, controlledProvider) {
  const initialUrl = page.url();
  const results = [];

  for (const [targetNumber, targetConfig] of hoverTargets.entries()) {
    const resolvedTarget = await resolveHoverTarget(page, targetConfig, timeout);
    const runtimeTargetConfig = resolvedTarget.config;
    const targets = page.locator(runtimeTargetConfig.selector);
    const targetCount = await targets.count();
    if (targetCount <= runtimeTargetConfig.index) {
      throw new Error(`悬浮目标不存在：${JSON.stringify({...runtimeTargetConfig, targetCount})}`);
    }
    const target = targets.nth(runtimeTargetConfig.index);
    const counts = [];
    const neighborCounts = [];
    const hoverTextPoints = [];
    const sourcePartitionEvidence = [];
    const sourcePartitionLedger = await captureSourcePartitionLedger(page, [runtimeTargetConfig], controlledProvider);

    for (const expected of [1, 0, 1]) {
      const point = await toggleHover(page, target, runtimeTargetConfig, expected, timeout, counts.length + 1, prepareClickText);
      if (runtimeTargetConfig.textIncludes?.length) hoverTextPoints.push(point);
      counts.push(await target.locator('.fluent-read-bilingual-content').count());
      const neighborCount = await targets.evaluateAll((nodes, activeIndex) => nodes.reduce((count, node, index) =>
        count + (index === activeIndex ? 0 : node.querySelectorAll('.fluent-read-bilingual-content').length), 0), runtimeTargetConfig.index);
      neighborCounts.push(neighborCount);
      if (neighborCount !== 0) {
        throw new Error(`${targetConfig.name} 悬浮误翻译相邻节点：${JSON.stringify(neighborCounts)}`);
      }
      await assertWrapperUniqueness(page, expected, `${targetConfig.name} 悬浮第 ${counts.length} 次切换`);
      await assertPageContract(
        page,
        pageContract,
        requiredSelectors,
        initialUrl,
        `${targetConfig.name} 悬浮第 ${counts.length} 次切换`,
      );
      if (expected === 1 && controlledProvider) await controlledProvider.assertPage(page, `${targetConfig.name} 悬浮第 ${counts.length} 次切换`);
      if (expected === 0) await assertRequiredRestored(page, pageContract, `${targetConfig.name} 悬浮恢复`);
      if (sourcePartitionLedger) sourcePartitionEvidence.push(await verifySourcePartitionLedger(page,
        sourcePartitionLedger, controlledProvider, `${targetConfig.name} 悬浮第 ${counts.length} 次切换`, expected === 0));
      if (artifactsDir && expected === 1) {
        const suffix = counts.length === 1 ? 'first' : 'final';
        await captureEvidence(page, path.join(artifactsDir, `hover-${targetNumber + 1}-${targetConfig.name}-${suffix}.png`));
      }
    }

    const translationText = (await target.locator('.fluent-read-bilingual-content').first().textContent() || '').trim();
    if (!/[\u3400-\u9fff]/u.test(translationText)) {
      throw new Error(`${targetConfig.name} 悬浮译文没有中文：${translationText}`);
    }
    results.push({
      ...targetConfig,
      requestedEligibleIndex: resolvedTarget.requestedEligibleIndex,
      rawIndex: resolvedTarget.rawIndex,
      sourceText: resolvedTarget.sourceText,
      counts,
      neighborCounts,
      translationText,
      ...(hoverTextPoints.length ? {hoverTextPoints} : {}),
      ...(sourcePartitionLedger ? {sourcePartitionEvidence} : {}),
    });

    // 为下一个语义类型清场，避免前一个 H1 的译文让全局 wrapper 计数
    // 掩盖 H2/P/LI 的真实命中结果。最后一个目标保留最终 [1] 状态。
    if (targetNumber < hoverTargets.length - 1) {
      await toggleHover(page, target, runtimeTargetConfig, 0, timeout, 4, prepareClickText);
      await assertWrapperUniqueness(page, 0, `${targetConfig.name} 悬浮目标清场`);
      await assertRequiredRestored(page, pageContract, `${targetConfig.name} 悬浮目标清场`);
      if (sourcePartitionLedger) sourcePartitionEvidence.push(await verifySourcePartitionLedger(page,
        sourcePartitionLedger, controlledProvider, `${targetConfig.name} 悬浮目标清场`, true));
    }
  }

  return {
    hoverTargets: results,
    counts: results[0]?.counts || [],
    neighborCounts: results[0]?.neighborCounts || [],
    translationText: results[0]?.translationText || '',
  };
}

// Read-only failure evidence: target geometry/occluders and visible modal candidates distinguish
// a deferred background page from a missing candidate without changing either completion contract.
function readFullPageFailureSnapshotInPage(targetSelector) {
  const targetNode = document.querySelector(targetSelector);
  const describe = (node, includeHtml = true) => {
    if (!node) return null;
    let style;
    try {style = getComputedStyle(node);} catch {style = null;}
    const rect = node.getBoundingClientRect();
    return {tag: node.tagName, id: node.id || '', className: String(node.className || ''),
      role: node.getAttribute('role'), ariaModal: node.getAttribute('aria-modal'),
      ariaHidden: node.getAttribute('aria-hidden'), inert: node.hasAttribute('inert'),
      translate: node.getAttribute('translate'), contenteditable: node.getAttribute('contenteditable'),
      rect: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height},
      style: style ? {display: style.display, visibility: style.visibility, opacity: style.opacity,
        position: style.position, zIndex: style.zIndex, overflow: style.overflow, overflowY: style.overflowY,
        pointerEvents: style.pointerEvents} : null,
      html: includeHtml ? node.outerHTML.slice(0, 4000) : undefined};
  };
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    let style;try {style = getComputedStyle(node);} catch {style = null;}
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.left < innerWidth && rect.top < innerHeight && style?.display !== 'none' &&
      style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.opacity !== '0';
  };
  const targetAncestors = [];
  for (let node = targetNode; node && targetAncestors.length < 12; node = node.parentElement) targetAncestors.push(describe(node, node === targetNode));
  const modalNodes = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog,.modal,.ant-modal,.el-dialog')].filter(visible);
  const maskNodes = [...document.querySelectorAll('[class*="overlay" i],[class*="backdrop" i],[class*="mask" i]')].filter(visible);
  const targetRect = targetNode?.getBoundingClientRect();
  const point = targetRect && {x: Math.max(0, Math.min(innerWidth - 1, targetRect.left + targetRect.width / 2)),
    y: Math.max(0, Math.min(innerHeight - 1, targetRect.top + targetRect.height / 2))};
  return {
    status: 'available', capturedAt: Date.now(), snapshotPhase: 'after-readiness-failure',
    totalBilingual: document.querySelectorAll('.fluent-read-bilingual-content').length,
    targetText: targetNode?.textContent?.trim() || '',
    targetBilingual: targetNode?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
    targetLoading: targetNode?.querySelectorAll('.fluent-read-loading').length || 0,
    targetRetry: targetNode?.querySelectorAll('.fluent-read-retry-wrapper').length || 0,
    translatedNodes: [...document.querySelectorAll('.fluent-read-bilingual-content')].slice(0, 32).map((node) => ({
      text: node.textContent?.trim().slice(0, 2000) || '', parent: node.parentElement?.outerHTML.slice(0, 500) || ''})),
    bodyText: (document.body?.innerText || '').slice(0, 1000), activeElement: document.activeElement?.outerHTML.slice(0, 500),
    targetAncestors, viewport: {width: innerWidth, height: innerHeight},
    targetPoint: point || null,
    pointStack: point && typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(point.x, point.y).slice(0, 8).map(node => describe(node)) : [],
    visibleModals: modalNodes.slice(0, 16).map(node => ({...describe(node), containsTarget: node.contains(targetNode),
      containsActive: node.contains(document.activeElement), text: node.textContent?.trim().slice(0, 2000)})),
    visibleMasks: maskNodes.slice(0, 16).map(node => describe(node)),
    visibleButtons: [...document.querySelectorAll('button,[role="button"]')].filter(visible).slice(0, 32)
      .map(node => ({...describe(node), text: node.textContent?.trim().slice(0, 100)})),
    truncated: {modals: modalNodes.length > 16, masks: maskNodes.length > 16},
  };
}

function readSanitizedFailureDomInPage() {
  const snapshotDocument = document.cloneNode(false);
  const clone = snapshotDocument.importNode(document.documentElement, true);
  clone.querySelectorAll('script,noscript,style').forEach(node => node.remove());
  clone.querySelectorAll('input').forEach(node => node.removeAttribute('value'));
  clone.querySelectorAll('textarea').forEach(node => {node.textContent = '';});
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (/nonce|csrf|token/iu.test(attribute.name)) node.removeAttribute(attribute.name);
    }
  }
  return '<!doctype html>\n' + clone.outerHTML;
}

async function completeFullPageScope({page, timeout, scrollContainer, selector, verifyUnchanged, waitForTarget,
  fullPageScope = 'finite-page'}, actions = {scrollAndWaitFullPage, settleCoverageByReveal,
  revealFullPageTarget, waitForTranslationIdle, observeCoverage}) {
  if (fullPageScope === 'finite-page') {
    return actions.scrollAndWaitFullPage(page, timeout, scrollContainer, selector, verifyUnchanged, waitForTarget);
  }
  if (fullPageScope !== 'initial-corpus') throw new Error(`Unknown full-page scope: ${fullPageScope}`);
  // 无限信息流没有终点。逐个暴露覆盖选择器中本轮已冻结的初始正文，每个 owner 仍须严格完成。
  await actions.settleCoverageByReveal(page, timeout, '本轮已载入正文覆盖收敛', 0, verifyUnchanged);
  await actions.revealFullPageTarget(page, selector);
  await waitForTarget();
  await actions.waitForTranslationIdle(page, timeout, '本轮已载入正文回到目标后', 0);
  await actions.observeCoverage(page);
}

async function runFullTranslationPass(context, pass) {
  const {
    page,
    selector,
    requiredSelectors,
    runtimeCoverageRules,
    fullCoverageSelectors,
    pageContract,
    interactionScenarios,
    controlSelector,
    scrollContainer,
    fullPageScope = 'finite-page',
    timeout,
    artifactsDir,
    initialUrl,
    readCompletion,
    previousCompletionSessionId,
    controlledProvider,
    sourcePartitionLedger = null,
  } = context;
  const first = pass === 'first';
  const phase = first ? '全文首次翻译' : '全文再次翻译';

  await clearCoverageCompletionPass(page);
  await toggleFull(page);
  reportProgress(first ? '已触发首次全文翻译' : '已触发第二次全文翻译');
  await revealFullPageTarget(page, selector);
  const readinessDeadline = Date.now() + timeout;
  let completionIdentity;
  let targetReadiness;
  const verifyUnchanged = (remaining = timeout) => verifyCoverageUnchanged(page, readCompletion, completionIdentity, remaining);
  const verifyTarget = async (remaining, observation) => {
    const deadline = Date.now() + remaining;
    if (!completionIdentity?.sessionId || !ownerCompletionLedgers.has(page)) {
      completionIdentity = await beginCoverageCompletionPass(page, readCompletion, previousCompletionSessionId, remaining);
    }
    return verifyCoverageUnchanged(page, readCompletion, completionIdentity, Math.max(0, deadline - Date.now()),
      observation.statuses.map(item => item.token));
  };
  const waitForTarget = (deadline = Date.now() + timeout) =>
    waitForFullTargetReadiness(page, selector, timeout, verifyTarget, deadline);
  try {
    completionIdentity = await beginCoverageCompletionPass(page, readCompletion, previousCompletionSessionId,
      Math.max(0, readinessDeadline - Date.now()));
    targetReadiness = await waitForTarget(readinessDeadline);
  } catch (error) {
    let diagnostics = {status: 'unavailable', reason: 'target-snapshot-unavailable'};
    try {
      diagnostics = await completionOperation(Date.now() + 2000, () => page.evaluate(readFullPageFailureSnapshotInPage, selector));
      if (artifactsDir) fs.writeFileSync(path.join(artifactsDir, `full-${pass}-readiness-failure.json`), JSON.stringify(diagnostics, null, 2));
    } catch { /* 保存原始 deadline 失败；无响应 renderer 不能阻止错误传播。 */ }
    throw new Error(`${error.message}\n全文 case 诊断：${JSON.stringify({phase, completionIdentity,
      readiness: error.readinessDiagnostic || {observationStatus: 'unavailable'}, ...diagnostics})}`, {cause: error});
  }

  const target = targetReadiness.target;
  if (first) reportProgress(`首次目标已完成 (${targetReadiness.completion})，验证 ${fullPageScope} 正文范围`);
  await completeFullPageScope({page, timeout, scrollContainer, selector, verifyUnchanged, waitForTarget, fullPageScope});
  await verifyUnchanged();
  const pageState = await readFullPageState(
    page,
    selector,
    requiredSelectors,
    fullCoverageSelectors,
    controlSelector,
  );
  const coverage = await readCoverageReport(page);
  reportProgress(`${first ? '首次全文稳定' : '第二次全文稳定'}：${pageState.totalBilingual} 个 wrapper`);
  const finalTargetReadiness = await readFullTargetReadiness(page, selector);
  const requiredReadiness = [];
  for (const item of pageState.requiredBilingual) {
    if (item.bilingualCount < 1) requiredReadiness.push(await readFullTargetReadiness(page, item.selector, item.index));
  }
  if (!finalTargetReadiness.ready ||
      (pageState.totalBilingual < 1 && !coverage.some(item => item.verifiedUnchangedCount > 0)) ||
      pageState.uniqueWrapperParents !== pageState.totalBilingual ||
      requiredReadiness.some(item => !item.ready) ||
      pageState.requiredBilingual.some((item) => !item.exists ||
        item.translationTexts.some((text) => !/[\u3400-\u9fff]/u.test(text))) ||
      pageState.fullCoverage.some((item) => item.visibleCount < 1 || item.translatedCount !== item.visibleCount)) {
    const message = first ? '全文滚动后状态异常' : '全文再次滚动后状态异常';
    throw new Error(`${message}：${JSON.stringify({pageState, finalTargetReadiness, requiredReadiness})}`);
  }
  assertCoverageReport(runtimeCoverageRules, coverage, phase);
  await assertWrapperUniqueness(page, null, phase);
  await assertPageContract(page, pageContract, requiredSelectors, initialUrl, phase);
  const interactions = await runInteractionScenarios(page, interactionScenarios, timeout, phase);
  if (controlSelector && (pageState.controlTexts.length === 0 ||
      pageState.controlTexts.some((text) => !/[\u3400-\u9fff]/u.test(text)))) {
    const message = first ? '全文按钮没有统一替换为译文' : '全文再次翻译按钮没有统一替换为译文';
    throw new Error(`${message}：${JSON.stringify(pageState.controlTexts)}`);
  }
  if (artifactsDir) {
    await captureEvidence(page, path.join(artifactsDir,
      first ? 'full-first-translation.png' : 'full-final-translation.png'));
  }
  const controlledAttribution = controlledProvider ? await controlledProvider.assertPage(page, phase) : undefined;
  const sourcePartitions = await verifySourcePartitionLedger(page, sourcePartitionLedger, controlledProvider, phase);
  return {target, pageState, coverage, interactions, completionIdentity, targetReadiness, finalTargetReadiness,
    controlledAttribution, sourcePartitions};
}

async function runFullCase(
  page,
  selector,
  requiredSelectors,
  coverageRules,
  fullCoverageSelectors,
  pageContract,
  interactionScenarios,
  controlSelector,
  scrollContainer,
  skipUnscopedH1Coverage,
  timeout,
  artifactsDir,
  readCompletion,
  controlledProvider,
  fullPageScope = 'finite-page',
) {
  const initialUrl = page.url();
  const baselineInteractionScenarios = await runInteractionScenarios(
    page,
    interactionScenarios,
    timeout,
    '全文翻译前基线',
  );
  const runtimeCoverageRules = withMandatoryHeadingCoverage(coverageRules,
    skipUnscopedH1Coverage ||
    pageContract.forbiddenState.some(({selector}) => /(?:^|[\s>+~,(])h1\b/iu.test(selector)), fullPageScope);
  const sourcePartitionLedger = await captureSourcePartitionLedger(page, runtimeCoverageRules, controlledProvider);
  await installCoverageTracker(page, runtimeCoverageRules);
  const passContext = {
    page,
    selector,
    requiredSelectors,
    runtimeCoverageRules,
    fullCoverageSelectors,
    pageContract,
    interactionScenarios,
    controlSelector,
    scrollContainer,
    fullPageScope,
    timeout,
    artifactsDir,
    initialUrl,
    readCompletion,
    controlledProvider,
    sourcePartitionLedger,
  };
  const firstPass = await runFullTranslationPass(passContext, 'first');
  passContext.previousCompletionSessionId = firstPass.completionIdentity.sessionId;

  await clearCoverageCompletionPass(page);
  await toggleFull(page);
  reportProgress('已触发全文恢复');
  await page.waitForFunction(
    () => document.querySelectorAll('.fluent-read-bilingual-content').length === 0,
    undefined,
    {timeout},
  );
  const restored = await readTargetState(page, selector);
  if (restored.bilingualCount !== 0) throw new Error(`全文恢复仍残留译文：${JSON.stringify(restored)}`);
  await assertWrapperUniqueness(page, 0, '全文恢复');
  await assertRequiredRestored(page, pageContract, '全文恢复');
  await assertPageContract(page, pageContract, requiredSelectors, initialUrl, '全文恢复');
  const restoredInteractionScenarios = await runInteractionScenarios(
    page,
    interactionScenarios,
    timeout,
    '全文恢复',
  );
  const restoredCoverage = await readCoverageRestoration(page);
  assertCoverageRestoration(restoredCoverage, '全文恢复');
  const restoredSourcePartitions = await verifySourcePartitionLedger(page, sourcePartitionLedger,
    controlledProvider, '全文恢复', true);
  await resetCoverageTracker(page);
  reportProgress('全文恢复完成');

  const secondPass = await runFullTranslationPass(passContext, 'second');
  return {
    fullPageScope,
    fullPageBoundary: fullPageScope === 'initial-corpus'
      ? 'all eligible nodes matching configured coverage selectors loaded at the start of each translation pass; does not claim the end of an infinite feed'
      : 'finite page through its stable bottom',
    controlledAttribution: [firstPass.controlledAttribution, secondPass.controlledAttribution],
    ...(sourcePartitionLedger ? {sourcePartitions: [firstPass.sourcePartitions, secondPass.sourcePartitions], restoredSourcePartitions} : {}),
    translated: firstPass.target,
    translatedPage: firstPass.pageState,
    coverage: firstPass.coverage,
    coverageCompletionContract: 'exact-owner-completion-v2',
    firstCompletionIdentity: firstPass.completionIdentity,
    secondCompletionIdentity: secondPass.completionIdentity,
    firstTargetReadiness: firstPass.targetReadiness,
    secondTargetReadiness: secondPass.targetReadiness,
    baselineInteractionScenarios,
    firstInteractionScenarios: firstPass.interactions,
    restored,
    restoredCoverage,
    restoredInteractionScenarios,
    retranslated: secondPass.target,
    retranslatedPage: secondPass.pageState,
    retranslatedCoverage: secondPass.coverage,
    secondInteractionScenarios: secondPass.interactions,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {diagnostics: runtimeDiagnostics, redact} = loadRuntimeDiagnostics(args.runtimeDiagnosticsHelper);
  const extensionDir = path.resolve(args.extensionDir);
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('插件 manifest.json 不存在');
  const buildFreshness = assertFreshProductionExtension(extensionDir);
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const artifactBinding = {manifest: sha256(path.join(extensionDir, 'manifest.json')),
    content: sha256(path.join(extensionDir, 'content-scripts/content.js')),
    background: sha256(path.join(extensionDir, 'background.js')),
    source: Object.fromEntries(['runtime.ts', 'mutationObservation.ts'].map(file =>
      [file, sha256(path.join(__dirname, '../src/features/full-page-translation/content', file))]))};
  if (!fs.existsSync(args.browserPath)) throw new Error(`浏览器不存在：${args.browserPath}`);

  const artifactsDir = args.artifactsDir ? path.resolve(args.artifactsDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-site-evidence-'));
  fs.mkdirSync(artifactsDir, {recursive: true});
  const {chromium} = loadPlaywright(args.playwrightRoot);
  const focusSafeHelper = loadFocusSafeHelper(args.focusSafeHelper);
  const monitorAvailable = typeof focusSafeHelper?.startFocusEventMonitor === 'function';
  const focusGuard = args.background ? createSiteFocusGuard(focusSafeHelper?.startFocusEventMonitor) : null;
  const viewport = {width: 1280, height: 900};
  const browserArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const newPage = focusSafeHelper
    ? focusSafeHelper.newPageWithoutForeground
    : async (targetContext) => targetContext.newPage();
  const createPage = async (...parameters) => {
    focusGuard?.mark('page-create-start');
    focusGuard?.check();
    const target = await newPage(...parameters);
    if (focusGuard) pageFocusGuards.set(target, focusGuard);
    focusGuard?.check();
    await runtimeDiagnostics.attachPage(target, 'site-test-page');
    focusGuard?.check();
    focusGuard?.mark('page-create-complete');
    return target;
  };
  const activateTab = async (...parameters) => {
    focusGuard?.mark('tab-activate-start');
    focusGuard?.check();
    if (focusSafeHelper) await focusSafeHelper.activateExtensionTabWithoutForeground(...parameters);
    focusGuard?.check();
    focusGuard?.mark('tab-activate-complete');
  };
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-site-case-'));
  let context;
  let launched;
  let primaryError;
  let output;
  let launchAttempted = false;
  let page;
  let extensionId;
  let diagnosticService = args.service;
  let controlledProvider;
  let promotionPreparation;
  let facebookPreparation;
  let failureDomEvidence;
  let runtimeStarted = false;
  const attemptStartedAt = Date.now();
  try {
    assertDedicatedProfile(profileDir);
    if (focusGuard && process.platform !== 'darwin') {
      throw Object.assign(new Error('后台焦点事件监控目前只支持 macOS；本次未启动浏览器'), {code: 'FOCUS_SAFETY_VIOLATION'});
    }
    if (focusGuard && !monitorAvailable) {
      throw Object.assign(new Error('后台模式必须支持原生焦点事件监控，不能仅依赖前台采样'), {code: 'FOCUS_SAFETY_VIOLATION'});
    }
    if (focusGuard) {await focusGuard.start(); focusGuard.mark('launch'); focusGuard.check();}
    if (focusSafeHelper) {
      launchAttempted = true;
      launched = await focusSafeHelper.launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath: args.browserPath,
        headless: false,
        background: args.background,
        browserArgs,
        viewport,
        timeout: args.timeout,
      });
      guardBrowserClose(launched, profileDir);
      if (focusGuard) {
        focusGuard.register(launched);
        let browserPid;
        try {browserPid = await getGuardedBrowserPid(launched);}
        catch (error) {focusGuard.fail(error); throw focusGuard.failure;}
        focusGuard.bind(launched, browserPid);
        focusGuard.mark('initialization');
      }
    } else {
      launchAttempted = true;
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: args.browserPath,
        headless: false,
        viewport,
        args: browserArgs,
      });
      launched = {
        context,
        launchMode: 'playwright-headed',
        focusPolicy: 'foreground-authorized',
        windowPlacement: {
          mode: 'headed-isolated',
          width: viewport.width,
          height: viewport.height,
          windowState: 'normal',
        },
        close: async () => context.close(),
      };
    }
    context = launched.context;
    focusGuard?.check();
    runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/initialization`);
    await runtimeDiagnostics.start(context);
    runtimeStarted = true;
    focusGuard?.check();
    const initialWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: args.timeout});
    extensionId = new URL(initialWorker.url()).host;
    runtimeDiagnostics.setExtensionId(extensionId);
    if (args.controlledProvider) controlledProvider = await installControlledProvider(context, createPage, args.timeout);
    page = await createPage(context, args.timeout);
    await runtimeDiagnostics.attachPage(page, 'translation-page');
    runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/navigation`);
    focusGuard?.mark('navigation'); focusGuard?.check();
    const navigation = await page.goto(args.url, {waitUntil: 'domcontentloaded', timeout: args.timeout});
    if (navigation && navigation.status() >= 400) throw new Error(`External site returned HTTP ${navigation.status()}: ${args.url}`);
    await activateTab(context, page, args.timeout);
    reportProgress(`${args.case}/${args.mode} 页面已加载`);
    // 当前 main 默认关闭悬浮球，但 Control/Alt+T 快捷键仍独立工作；
    // 这里等待 content script 初始化，而不是要求 UI 浮球必须存在。
    await page.waitForTimeout(1000);
    if (args.prepareClickText) {
      // Cookie 同意框等真正阻塞页面的站点对话框需由可信 UI 操作关闭，随后再验证正文全文翻译。
      const button = page.getByText(args.prepareClickText, {exact: true}).filter({visible: true}).last();
      const appeared = await button.waitFor({state: 'visible', timeout: Math.min(args.timeout, 10000)})
        .then(() => true, () => false);
      if (appeared) {
        assertPageFocusAllowed(page);
        await button.click({timeout: args.timeout});
        await button.waitFor({state: 'hidden', timeout: args.timeout});
        reportProgress(`已关闭站点对话框：${args.prepareClickText}`);
      }
    }
    if (args.prepareScrollSelector) {
      // Some landing pages reveal existing DOM only after it enters the viewport.
      // Use normal browser scrolling; never remove the site's hidden markers.
      assertPageFocusAllowed(page);
      await page.locator(args.prepareScrollSelector).first().scrollIntoViewIfNeeded({timeout: args.timeout});
      reportProgress(`页面预滚动已完成：${args.prepareScrollSelector}`);
    }
    if (args.prepareDismissiblePromotion) {
      // 实站可能在早期准备后才激活推广；正常预滚动后有界等候，再检查唯一安全关闭动作。
      await page.waitForTimeout(Math.min(2000, args.timeout));
      runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/dismissible-promotion`);
      promotionPreparation = {status: 'started', ...args.prepareDismissiblePromotion};
      promotionPreparation = await prepareDismissiblePromotion(page, args.prepareDismissiblePromotion, args.url, args.timeout);
      reportProgress(`公开推广准备完成：${promotionPreparation.status}`);
    }
    if (args.prepareFacebookPublicPost) {
      runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/facebook-public-post-preparation`);
      facebookPreparation = {status: 'started'};
      facebookPreparation = await prepareFacebookPublicPost(page, args.url, args.timeout, () => assertPageFocusAllowed(page));
      await authorizeFacebookReadingDialog(page, facebookPreparation);
      reportProgress(`Facebook 公开帖子准备完成：${facebookPreparation.status}，绑定原生正文 dialog`);
    }
    const hostMathRendering = await waitForHostMathRendering(page, args.timeout);
    await waitForStableTarget(page, args.selector, args.timeout);
    await waitForPageContract(
      page,
      args.requiredSelectors,
      args.forbiddenSelectors,
      args.forbiddenMustExistSelectors,
      args.interactionSelectors,
      args.timeout,
    );
    if (args.mode === 'full') {
      await waitForCoverageReady(page, args.coverageRules, args.timeout);
    }
    const pageContract = await capturePageContract(
      page,
      args.requiredSelectors,
      args.forbiddenSelectors,
      args.interactionSelectors,
      args.dynamicForbiddenSelectors,
      args.optionalForbiddenSelectors,
      args.mutableForbiddenSelectors,
    );
    const configResult = await readConfig(context, args.timeout, createPage, activateTab);
    focusGuard?.check();
    extensionId = configResult.extensionId;
    runtimeDiagnostics.setExtensionId(extensionId);
    diagnosticService = configResult.config?.service || args.service;
    // 读取配置时会临时激活 popup 页；关闭它后显式还原目标页，确保真实快捷键发给站点标签页。
    await activateTab(context, page, args.timeout);
    const config = configResult.config || {};
    const expectedHotkey = args.mode === 'hover' ? args.hoverHotkey : args.fullPageHotkey;
    if (config.service !== args.service) throw new Error(`服务不符：预期 ${args.service}，实际 ${config.service}`);
    if (Number(config.display) !== 1) throw new Error(`预期双语模式 display=1，实际 ${config.display}`);
    if (args.mode === 'hover' && config.hotkey !== expectedHotkey) throw new Error(`悬浮快捷键不符：${config.hotkey}`);
    if (args.mode === 'full' && config.floatingBallHotkey !== expectedHotkey) throw new Error(`全文快捷键不符：${config.floatingBallHotkey}`);
    reportProgress(`${args.case}/${args.mode} 页面 contract 与扩展配置已就绪`);
    runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/translate-restore-retranslate`);
    focusGuard?.mark('translate-restore-retranslate'); focusGuard?.check();

    const result = args.mode === 'hover'
      ? await runHoverCase(
        page,
        args.hoverTargets,
        args.requiredSelectors,
        pageContract,
        args.timeout,
        artifactsDir,
        args.case === 'roadmap-frontend' ? args.prepareClickText : undefined,
        controlledProvider,
      )
      : await runFullCase(
        page,
        args.selector,
        args.requiredSelectors,
        args.coverageRules,
        args.fullCoverageSelectors,
        pageContract,
        args.interactionScenarios,
        args.controlSelector,
        args.scrollContainer,
        args.skipUnscopedH1Coverage,
        args.timeout,
        artifactsDir,
        await createUnchangedCompletionReader(context, page, args.timeout),
        controlledProvider,
        args.fullPageScope,
      );
    focusGuard?.check();
    const nativeComments = args.stabilityProbes && args.case === 'hacker-news-8863'
      ? await runNativeCommentToggle({page, timeout: args.timeout, artifactsDir, checkFocus: () => assertPageFocusAllowed(page)}) : undefined;
    const stability = args.stabilityProbes
      ? await runStabilityProbes({page, selector: args.selector, timeout: args.timeout, artifactsDir, toggleFull, observeMs: 5000, checkFocus: () => assertPageFocusAllowed(page)}) : undefined;
    focusGuard?.check();
    output = {
      ok: true,
      artifactsDir,
      artifactBinding,
      buildFreshness,
      stability,
      nativeComments,
      providerEvidence: controlledProvider ? await controlledProvider.snapshot() : {mode: 'live-provider'},
      case: args.case,
      mode: args.mode,
      hostMathRendering,
      promotionPreparation,
      facebookPreparation,
      url: args.url,
      selector: args.selector,
      requiredSelectors: args.requiredSelectors,
      forbiddenSelectors: args.forbiddenSelectors,
      optionalForbiddenSelectors: args.optionalForbiddenSelectors,
      forbiddenMustExistSelectors: args.forbiddenMustExistSelectors,
      dynamicForbiddenSelectors: args.dynamicForbiddenSelectors,
      mutableForbiddenSelectors: args.mutableForbiddenSelectors,
      fullCoverageSelectors: args.fullCoverageSelectors,
      coverageRules: args.coverageRules,
      hoverTargets: args.hoverTargets,
      interactionSelectors: args.interactionSelectors,
      interactionScenarios: args.interactionScenarios,
      tier: args.tier,
      windowMode: args.background ? 'background-visible-no-focus' : 'headed-isolated',
      launchMode: launched.launchMode,
      focusPolicy: launched.focusPolicy,
      windowPlacement: launched.windowPlacement,
      service: config.service,
      display: config.display,
      screenshots: artifactsDir ? fs.readdirSync(artifactsDir).map((name) => path.join(artifactsDir, name)) : [],
      ...result,
    };
  } catch (error) {
    primaryError = error;
    if (focusGuard && monitorAvailable && process.platform === 'darwin' && error?.code === 'FOCUS_SAFETY_VIOLATION') focusGuard.fail(error);
    if (focusGuard?.failure) throw focusGuard.failure;
    if (focusGuard && (!monitorAvailable || process.platform !== 'darwin')) throw error;
    runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/failure-evidence`);
    // 只在失败后、既有清理前旁路取证；共用最多 2 秒，不修改测试/provider 预算或重试。
    const budgetMs = Math.min(args.timeout, 2000);
    const startedAt = Date.now();
    const deadlineAt = startedAt + budgetMs;
    const diagnostics = {
      case: args.case, mode: args.mode, budgetMs, attemptStartedAt,
      page: {status: 'unavailable', reason: 'page-not-read'},
      provider: {
        serviceId: diagnosticService, status: 'unavailable',
        ownerCorrelation: 'unavailable', timeoutRouteAttribution: 'unavailable',
        scope: 'today rollup in isolated profile; timeout list filtered by attempt start',
        query: {status: 'unavailable', reason: 'not-read'},
        list: {status: 'unavailable', reason: 'not-read'},
      },
    };
    let expired = false;
    let timer;
    const collect = async () => {
      let statsPage;
      let optionsStage = 'page-selection';
      try {
        if (page && !page.isClosed()) {
          let failureDom;
          try {
            const html = await page.evaluate(readSanitizedFailureDomInPage);
            if (!expired) {
              const file = path.join(artifactsDir, 'failure-native-dom.html');
              fs.writeFileSync(file, html);
              failureDom = {status: 'saved', path: file,
                sanitization: 'scripts/styles removed; input values, textarea contents and nonce/csrf/token attributes removed; source DOM unchanged'};
            }
          } catch {failureDom = {status: 'unavailable', reason: 'native-dom-read-unavailable'};}
          if (expired) return;
          failureDomEvidence = failureDom;
          try {
            const snapshot = await page.evaluate(() => {
              const owned = (name) => `.${name}[data-fr-translation-owned="true"]`;
              const bilingualSelector = owned('fluent-read-bilingual-content');
              const wrappers = [...document.querySelectorAll(bilingualSelector)];
              const loading = [...document.querySelectorAll(owned('fluent-read-loading'))];
              const retries = [...document.querySelectorAll(owned('fluent-read-retry-wrapper'))];
              const owners = (nodes) => [...new Set(nodes.map(node => node.parentElement).filter(Boolean))];
              const sample = (nodes) => owners(nodes).slice(0, 32).map(owner => ({
                tag: owner.tagName, id: owner.id.slice(0, 160),
                directOwned: [...owner.children].filter(child =>
                  child.getAttribute('data-fr-translation-owned') === 'true').length,
              }));
              const panel = document.querySelector('#fluent-read-translation-status-container')?.shadowRoot
                ?.querySelector('.fr-translation-progress');
              const progress = panel ? {status: 'available'} : {status: 'unavailable', reason: 'panel-absent'};
              if (panel) for (const field of ['session-id', 'running', 'remaining', 'queued', 'offscreen', 'deferred']) {
                const raw = panel.getAttribute(`data-${field}`);
                progress[field] = raw !== null && raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0
                  ? Number(raw) : null;
              }
              const scrolling = document.scrollingElement;
              return {
                capturedAt: Date.now(), url: `${location.origin}${location.pathname}`.slice(0, 1000),
                readyState: document.readyState, visibilityState: document.visibilityState,
                scroll: {top: scrolling?.scrollTop ?? null, height: scrolling?.scrollHeight ?? null,
                  viewportHeight: window.innerHeight},
                owned: {wrappers: wrappers.length, uniqueWrapperParents: owners(wrappers).length,
                  nestedWrappers: wrappers.filter(node => node.parentElement?.closest(bilingualSelector)).length,
                  loading: loading.length, loadingOwners: owners(loading).length,
                  retries: retries.length, retryOwners: owners(retries).length,
                  loadingOwnerSamples: sample(loading), retryOwnerSamples: sample(retries),
                  ownerSamplesTruncated: owners(loading).length > 32 || owners(retries).length > 32},
                progress, requestSlotCounts: 'unavailable',
              };
            });
            if (!expired) diagnostics.page = {status: 'available', ...snapshot, failureDom};
          } catch { if (!expired) diagnostics.page.reason = 'page-read-unavailable'; }
        } else diagnostics.page.reason = 'page-unavailable';
        if (expired) return;
        if (!extensionId || !context) {
          diagnostics.provider.query.reason = diagnostics.provider.list.reason = 'extension-unavailable';
          return;
        }
        diagnostics.provider.query.reason = diagnostics.provider.list.reason = 'options-not-ready';
        // 仅在失败且已保存宿主快照后，复用本次隔离 context 的失败页读取 options 统计。
        // 不新建或激活标签页；context 的既有 finally 仍负责关闭此页。
        if (diagnostics.page.status !== 'available' || !page || page.isClosed()
          || !context.pages().includes(page)) {
          diagnostics.provider.query.reason = diagnostics.provider.list.reason = 'owned-failure-page-unavailable';
          return;
        }
        statsPage = page;
        if (expired) return;
        optionsStage = 'page-navigation';
        await statsPage.goto(`chrome-extension://${extensionId}/options.html`, {
          waitUntil: 'domcontentloaded', timeout: Math.max(1, deadlineAt - Date.now()),
        });
        if (expired) return;
        await Promise.all(['query', 'list'].map(async (action) => {
          diagnostics.provider[action].reason = 'read-pending';
          try {
            const result = await statsPage.evaluate(async ({action, serviceId, since, remainingMs}) => {
              const reply = await new Promise((resolve) => {
                let settled = false;
                let timer;
                const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
                timer = setTimeout(() => finish(null), remainingMs);
                const filter = {range: 'today', serviceId};
                const message = action === 'query' ? {type: 'translationStats', action, filter}
                  : {type: 'translationStats', action, query: {
                    filter: {...filter, outcome: 'timeout'}, sort: 'recent', offset: 0, limit: 100,
                  }};
                try {
                  chrome.runtime.sendMessage(message, (response) => {
                    const runtimeError = chrome.runtime.lastError;
                    finish(runtimeError ? null : response);
                  });
                } catch { finish(null); }
              });
              const unavailable = (reason) => ({status: 'unavailable', reason});
              if (reply?.success !== true || !reply.data) return unavailable('stats-api-unavailable');
              const data = reply.data;
              const numeric = (record, keys) => Object.fromEntries(keys.map(key => [key,
                typeof record?.[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0
                  ? record[key] : null]));
              const outcomes = (record) => numeric(record, ['success', 'error', 'timeout', 'cancelled']);
              const routes = (values) => Array.isArray(values)
                ? values.filter(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)).slice(0, 16)
                : [];
              if (action === 'query') {
                if (data.selected?.filter?.serviceId !== serviceId || !data.selected.totals) return unavailable('stats-shape-unavailable');
                const totals = data.selected.totals;
                const hasRequests = typeof totals.requestCount === 'number'
                  && Number.isFinite(totals.requestCount) && totals.requestCount > 0;
                const routeRows = Array.isArray(data.routes) ? data.routes.filter(row =>
                  row.serviceId === serviceId && routes([row.route]).length && row.totals).slice(0, 16).map(row => ({
                    route: row.route, ...numeric(row.totals, ['attemptCount', 'averageDurationMs', 'maxDurationMs']),
                    recordedOutcomes: outcomes(row.totals.outcomes),
                  })) : [];
                return {
                  status: hasRequests ? 'available' : 'unavailable',
                  reason: hasRequests ? null : 'no-recorded-requests', ...numeric(data, ['generatedAt']),
                  totals: {...numeric(totals, ['requestCount', 'segmentCount', 'cachedSegments', 'upstreamCalls',
                    'averageDurationMs', 'maxDurationMs', 'averageUpstreamMs']), recordedOutcomes: outcomes(totals.outcomes)},
                  routeStats: {status: routeRows.length ? 'available' : 'unavailable',
                    timeoutRouteAttribution: 'unavailable', rows: routeRows},
                };
              }
              if (data.filter?.serviceId !== serviceId || !Array.isArray(data.items)) return unavailable('stats-shape-unavailable');
              const items = data.items.slice(0, 100).filter(row => row.serviceId === serviceId
                && typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) && row.startedAt >= since && row.outcome === 'timeout').map(row => ({
                  ...numeric(row, ['startedAt', 'durationMs', 'segmentCount', 'sourceChars', 'sourceBytes',
                    'cachedSegments', 'upstreamCalls', 'upstreamMs', 'statusCode']), outcome: 'timeout',
                  mode: ['single', 'batch', 'image'].includes(row.mode) ? row.mode : null,
                  errorKind: ['authentication', 'rate-limit', 'timeout', 'network', 'bad-request', 'provider',
                    'response', 'unknown'].includes(row.errorKind) ? row.errorKind : null,
                  recordedRoutes: routes(row.routes), timeoutRouteAttribution: 'unavailable',
                }));
              return {status: items.length ? 'available' : 'unavailable',
                reason: items.length ? null : 'no-timeout-records-in-attempt-window',
                ...numeric(data, ['generatedAt', 'totalCount', 'limit', 'offset']),
                truncated: data.totalCount > data.items.length || data.items.length > 100, items};
            }, {action, serviceId: diagnosticService, since: attemptStartedAt,
              remainingMs: Math.max(1, deadlineAt - Date.now())});
            if (!expired) diagnostics.provider[action] = result;
          } catch { if (!expired) diagnostics.provider[action].reason = 'stats-read-unavailable'; }
        }));
      } catch (diagnosticError) {
        const detail = String(diagnosticError?.message || '');
        const failureCode = detail.match(/\bnet::ERR_(?:ABORTED|FAILED|TIMED_OUT|CONNECTION_CLOSED|CONNECTION_REFUSED|CONNECTION_RESET|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)\b/u)?.[0]
          || (diagnosticError?.name === 'TimeoutError' ? 'navigation-timeout'
            : /macOS.*前台|无法读取.*前台/u.test(detail) ? 'foreground-query-unavailable'
            : /成了.*前台|成为.*前台/u.test(detail) ? 'foreground-guard-rejected'
            : /后台页签未/u.test(detail) ? 'page-attachment-unavailable' : 'unclassified');
        if (!expired) for (const action of ['query', 'list']) {
          if (diagnostics.provider[action].status === 'unavailable') diagnostics.provider[action] = {
            status: 'unavailable', reason: 'options-read-unavailable', stage: optionsStage, failureCode,
          };
        }
      }
    };
    try {
      await Promise.race([collect().catch(() => {}), new Promise(resolve => {
        timer = setTimeout(() => { expired = true; resolve(); }, budgetMs);
      })]);
      const budgetExhausted = expired || Date.now() >= deadlineAt;
      expired = true;
      if (budgetExhausted) {
        if (diagnostics.page.status === 'unavailable') diagnostics.page.reason = 'diagnostic-budget-exhausted';
        for (const action of ['query', 'list']) if (diagnostics.provider[action].status === 'unavailable'
          && ['not-read', 'options-not-ready', 'read-pending'].includes(diagnostics.provider[action].reason)) {
          diagnostics.provider[action].reason = 'diagnostic-budget-exhausted';
        }
      }
      diagnostics.provider.status = ['query', 'list'].some(action => diagnostics.provider[action].status === 'available')
        ? 'available' : 'unavailable';
      reportProgress(`failure diagnostics ${JSON.stringify({...diagnostics,
        budgetExhausted, elapsedMs: Date.now() - startedAt})}`);
    } catch { /* 取证失败不能覆盖 original error 或推迟既有清理。 */ }
    finally { expired = true; clearTimeout(timer); }
    throw error;
  }
  finally {
    const cleanupErrors = [];
    try {controlledProvider?.dispose();} catch (error) {cleanupErrors.push(error);}
    output ||= {ok: false, artifactsDir, case: args.case, mode: args.mode, url: args.url,
      launchMode: launched?.launchMode, focusPolicy: launched?.focusPolicy, windowPlacement: launched?.windowPlacement};
    if (promotionPreparation) output.promotionPreparation = promotionPreparation;
    if (facebookPreparation) output.facebookPreparation = facebookPreparation;
    if (primaryError) {output.ok = false; output.error = redact(primaryError.message || primaryError);}
    if (primaryError?.readinessDiagnostic) output.coverageReadinessDiagnostic = primaryError.readinessDiagnostic;
    if (primaryError?.promotionDiagnostic) output.promotionDiagnostic = primaryError.promotionDiagnostic;
    if (primaryError?.facebookPreparation) output.facebookPreparation = primaryError.facebookPreparation;
    if (failureDomEvidence) output.failureNativeDom = failureDomEvidence;
    try {
      if (focusGuard?.failure) throw focusGuard.failure;
      output.unload = await unloadRuntimePage(page, runtimeDiagnostics, `${args.case}/${args.mode}/unload`);
      if (output.ok && output.unload.status !== 'observed') throw new Error('未观察到目标文档卸载，不能判定本轮通过');
    }
    catch (error) {
      output.unload = {status: 'failed', message: redact(error.message || error)};
      cleanupErrors.push(error);
    }
    try {runtimeDiagnostics.setPhase(`${args.case}/${args.mode}/cleanup`);} catch (error) {cleanupErrors.push(error);}
    let diagnosticFailures = [];
    try {diagnosticFailures = await finishRuntimeDiagnostics(runtimeDiagnostics, output, artifactsDir);}
    catch (error) {cleanupErrors.push(error); output.ok = false;}
    cleanupErrors.push(...diagnosticFailures.map(({error}) => error));
    if (!runtimeStarted) {
      output.runtimeDiagnostics = {...output.runtimeDiagnostics, passed: false, status: 'not-started'};
    }
    if (diagnosticFailures.length) output.finalizationErrors = diagnosticFailures.map(({stage, error}) => ({stage, message: redact(error.message || error)}));
    if (!focusGuard?.failure) try {await releaseFacebookReadingDialog(page);} catch (error) {cleanupErrors.push(error);}
    let browserClosed = false;
    focusGuard?.mark('browser-close');
    try {
      if (launched?.close) {await (focusGuard?.requestClose() || launched.close()); browserClosed = true;}
      else if (context) {await context.close(); browserClosed = true;}
    } catch (error) {cleanupErrors.push(error);}
    if (focusGuard) {
      focusGuard.mark('observer-stop');
      try {await focusGuard.stop();} catch (error) {cleanupErrors.push(error);}
      output.focusObservation = focusGuard.snapshot();
      if (output.focusObservation.status !== 'complete') output.ok = false;
    } else output.focusObservation = {status: 'not-monitored', reason: 'explicit-headed-mode'};
    try {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      else if (!launchAttempted) {
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    } catch (error) {cleanupErrors.push(error);}
    output.cleanupConfirmed = browserClosed;
    try {output.profileRemoved = !fs.existsSync(profileDir);} catch (error) {output.profileRemoved = null; cleanupErrors.push(error);}
    if (cleanupErrors.length) {
      output.ok = false;
      output.cleanupErrors = cleanupErrors.map(error => ({message: redact(error.message || error)}));
    }
    try {if (output.runtimeDiagnostics) fs.writeFileSync(path.join(artifactsDir, 'runtime-diagnostics.json'), JSON.stringify(output.runtimeDiagnostics, null, 2));}
    catch (error) {cleanupErrors.push(error); output.ok = false;}
    if (cleanupErrors.length) output.cleanupErrors = cleanupErrors.map(error => ({message: redact(error.message || error)}));
    try {
      fs.writeFileSync(path.join(artifactsDir, 'result.json'), JSON.stringify(output, null, 2));
      reportProgress(`证据目录：${artifactsDir}`);
    } catch (error) {cleanupErrors.push(error); output.ok = false;}
    for (const error of cleanupErrors) {
      process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
      reportErrorCodes(error, 'cleanup');
    }
    if (focusGuard?.failure) throw focusGuard.failure;
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    reportErrorCodes(error, 'terminal');
    process.exitCode = siteTestExitCode(error);
  });
}

module.exports = {
  parseArgs,
  captureEvidence,
  prepareDismissiblePromotion,
  authorizeFacebookReadingDialog,
  releaseFacebookReadingDialog,
  coverageEligibilityContext,
  readDismissiblePromotionStateInPage,
  loadRuntimeDiagnostics,
  finishRuntimeDiagnostics,
  unloadRuntimePage,
  completeFullPageScope,
  COVERAGE_EXCLUDED_ANCESTORS,
  COVERAGE_PROTECTED_DESCENDANTS,
  COVERAGE_TRACKER_KEY,
  assertPageContract,
  assertFreshProductionExtension,
  assertCoverageReport,
  assertCoverageRestoration,
  capturePageContract,
  evaluateProductionBuildFreshness,
  installCoverageTracker,
  createUnchangedCompletionReader,
  readCoverageReport,
  readCoverageStatuses,
  readFullTargetReadiness,
  readFullPageFailureSnapshotInPage,
  readSanitizedFailureDomInPage,
  waitForFullTargetReadiness,
  runFullCase,
  captureSourcePartitionLedger,
  verifySourcePartitionLedger,
  beginCoverageCompletionPass,
  verifyCoverageUnchanged,
  isNaturalLanguageText,
  newestFile,
  reconcileForbiddenContractState,
  findHoverTextPointInPage,
  waitForHoverPointer,
  toggleHover,
  resolveHoverTarget,
  settleCoverageByReveal,
  closeInteractionDialog,
  validateCoverageRevealStatuses,
  waitForCoverageReady,
  readCoverageReadinessInPage,
  waitForHostMathRendering,
  observeTranslationIdleInPage,
  waitForTranslationIdle,
  scrollAndWaitFullPage,
  waitForStableTarget,
  withMandatoryHeadingCoverage,
};
