#!/usr/bin/env node

// 运行真实网站的悬浮翻译或全文翻译回归。
//
// 这个脚本只创建临时 Edge profile，并使用第二屏不抢焦点的正常窗口；它不会连接用户日常
// 浏览器，也不会通过 page.evaluate 派发伪造的键盘事件。Control 和 Alt+T
// 都由 Playwright keyboard API 发送真实的浏览器按键。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {
  CASES,
  collectBaseCaseConfigErrors,
  normalizeCaseConfig,
} = require('./site-translation/case-config.cjs');

const PRODUCTION_SOURCE_ROOTS = ['src', 'entrypoints', 'components', 'public', 'styles'];
const PRODUCTION_CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'wxt.config.ts', 'tsconfig.json'];
const INTERACTION_CLOSE_ATTEMPT_TIMEOUT = 1500;
const SINGLE_TOKEN_TECHNICAL_WORDS = new Set([
  'accept', 'api', 'authorization', 'cookie', 'css', 'etag', 'host', 'html', 'http', 'https', 'json',
  'referer', 'referrer', 'sql', 'tcp', 'tls', 'udp', 'uri', 'url', 'user-agent', 'xml',
]);

function isNaturalLanguageText(value) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
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
  if (!args.case) throw new Error('必须传入 --case，例如 example-com');
  if (!CASES[args.case]) throw new Error(`未知 case：${args.case}`);
  if (!['hover', 'full'].includes(args.mode)) throw new Error('--mode 必须是 hover 或 full');
  if (!args.extensionDir) throw new Error('必须传入 --extension-dir');
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root');
  if (!args.allowNetwork) throw new Error('真实网络站点测试必须显式传入 --allow-network');
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

  return {
    ...caseConfig,
    ...args,
    ...normalized,
  };
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
    if (state.translatedCount !== state.seenCount) {
      errors.push(`${rule.name} 仅翻译 ${state.translatedCount}/${state.seenCount} 个节点` +
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

function withMandatoryHeadingCoverage(rules) {
  return [
    ...rules,
    {
      name: 'mandatory-visible-latin-h1',
      selector: 'h1',
      kind: 'heading',
      minInitial: 0,
      minSeen: 0,
      trackDynamic: true,
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

async function waitForCoverageReady(page, rules, timeout) {
  try {
    await page.waitForFunction(({coverageRules, excludedSelector, protectedSelector, technicalWords}) => {
      const technicalWordSet = new Set(technicalWords);
      const naturalLanguage = (value) => {
        const text = String(value || '').replace(/\s+/gu, ' ').trim();
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
        const clone = node.cloneNode(true);
        clone.querySelectorAll(
          '.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, [data-fr-translation-owned="true"]',
        ).forEach((owned) => owned.remove());
        clone.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => {
          segment.replaceWith(...segment.childNodes);
        });
        clone.querySelectorAll(protectedSelector).forEach((protectedNode) => protectedNode.remove());
        return (clone.textContent || '').replace(/\s+/gu, ' ').trim();
      };
      const eligible = (node, rule) => {
        if (!(node instanceof HTMLElement) || node.closest(excludedSelector)) return false;
        if (node.closest('.fluent-read-bilingual-content, [data-fr-translation-owned="true"]')) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const text = sourceText(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          naturalLanguage(text) && (!rule.requiresPhrase || /[\s.,:;!?()\-]/u.test(text));
      };
      return coverageRules.every((rule) => {
        const texts = [...document.querySelectorAll(rule.selector)].filter((node) => eligible(node, rule)).map(sourceText);
        return texts.length >= rule.minInitial &&
          rule.sourceIncludes.every((fragment) => texts.some((text) => text.includes(fragment)));
      });
    }, {
      coverageRules: rules,
      excludedSelector: COVERAGE_EXCLUDED_ANCESTORS,
      protectedSelector: COVERAGE_PROTECTED_DESCENDANTS,
      technicalWords: [...SINGLE_TOKEN_TECHNICAL_WORDS],
    }, {timeout});
  } catch (error) {
    const diagnostics = await page.evaluate((coverageRules) => coverageRules.map((rule) => ({
      name: rule.name,
      selector: rule.selector,
      count: document.querySelectorAll(rule.selector).length,
      samples: [...document.querySelectorAll(rule.selector)].slice(0, 8)
        .map((node) => (node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 180)),
    })), rules);
    throw new Error(`${error.message}\ncoverageRules 页面就绪诊断：${JSON.stringify(diagnostics)}`);
  }
}

async function installCoverageTracker(page, rules) {
  await page.evaluate(({coverageRules, trackerKey, excludedSelector, protectedSelector, technicalWords}) => {
    window[trackerKey]?.stop?.();
    const ownedSelector = [
      '.fluent-read-bilingual-content',
      '.fluent-read-loading',
      '.fluent-read-retry-wrapper',
      '[data-fr-translation-owned="true"]',
    ].join(', ');
    const artifactSelector = `${ownedSelector}, [data-fr-translation-segment="true"]`;
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const technicalWordSet = new Set(technicalWords);
    const naturalLanguage = (text) => {
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
      const clone = node.cloneNode(true);
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
      if (!(node instanceof HTMLElement) || node.closest(excludedSelector)) return false;
      if (node.closest(ownedSelector)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
        naturalLanguage(text) && (!rule.requiresPhrase || /[\s.,:;!?()\-]/u.test(text));
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
          if (!(node instanceof HTMLElement) || node.closest(excludedSelector) || node.closest(ownedSelector)) continue;
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
        if (elementFor(mutation.target)?.closest?.(protectedSelector) || onlyCanonicalIgnoredChildren(mutation)) {
          metrics.ignoredProtectedMutationCount += 1;
          continue;
        }
        metrics.hostMutationCount += 1;
        processHostMutation(mutation);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert'],
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

    window[trackerKey] = {
      scan: cheapRefresh,
      metrics: () => ({...metrics}),
      reset() {
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
        found.record.node.scrollIntoView?.({block: 'center', inline: 'nearest'});
        return {...status, found: true, alreadyTranslated: false};
      },
      missingStatuses(tokens) {
        return tokens.map((token) => {
          const found = findToken(token);
          if (found) {
            const status = statusFor(found.state, found.record, token);
            if (found.generationMatches ||
                (!status.connected && found.state.rule.trackDynamic && found.record.translatedEver)) return status;
            return {...status, translated: false, reason: 'stale-generation'};
          }
          return {token, connected: false, eligible: false, translated: false, loading: false, retry: false,
            rule: '', source: '', reason: 'stale-token'};
        });
      },
      report() {
        cheapRefresh();
        return states.map((state) => {
          const {rule, recordsById} = state;
          const values = [...recordsById.values()];
          // 对仍连接的节点必须看到“当前”归属于它的 wrapper；translatedEver
          // 只用于虚拟列表中已经移除的动态节点，不能让旧译文冒充重译成功。
          const missed = values.filter((record) => record.node?.isConnected
            ? !recordCurrentlyTranslated(state, record)
            : !record.translatedEver);
          return {
            name: rule.name,
            selector: rule.selector,
            seenCount: values.length,
            dynamicSeenCount: values.filter((record) => record.firstSeenAfterStart).length,
            translatedCount: values.length - missed.length,
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
        observer.disconnect();
        document.removeEventListener('scroll', cheapRefresh, true);
      },
    };
  }, {
    coverageRules: rules,
    trackerKey: COVERAGE_TRACKER_KEY,
    excludedSelector: COVERAGE_EXCLUDED_ANCESTORS,
    protectedSelector: COVERAGE_PROTECTED_DESCENDANTS,
    technicalWords: [...SINGLE_TOKEN_TECHNICAL_WORDS],
  });
}

async function observeCoverage(page) {
  await page.evaluate((trackerKey) => window[trackerKey]?.scan?.(), COVERAGE_TRACKER_KEY);
}

async function readCoverageReport(page) {
  return page.evaluate((trackerKey) => window[trackerKey]?.report?.() || [], COVERAGE_TRACKER_KEY);
}

async function readCoverageRestoration(page) {
  return page.evaluate((trackerKey) => window[trackerKey]?.restorationReport?.() || [], COVERAGE_TRACKER_KEY);
}

async function resetCoverageTracker(page) {
  await page.evaluate((trackerKey) => window[trackerKey]?.reset?.(), COVERAGE_TRACKER_KEY);
}

function validateCoverageRevealStatuses(statuses, phase) {
  const unresolved = statuses.filter((status) => !status.translated);
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
// 有界收敛后仍在重试、服务结果未变化、节点断开或缺少 wrapper，测试都会失败。
async function settleCoverageByReveal(page, timeout, phase) {
  const startedAt = Date.now();
  const maxAttempts = 128;
  const dwellMs = 900;
  const batch = await page.evaluate(
    (trackerKey) => window[trackerKey]?.snapshotMissing?.() || [],
    COVERAGE_TRACKER_KEY,
  );
  // 每个叶节点固定停留一次，整批停留之外再保留 timeout 等待共享队列收敛。
  // 若只给固定 timeout，67–128 个节点的合法批次会在逐节点阶段必然耗尽预算。
  const deadline = startedAt + batch.length * dwellMs + timeout;
  if (batch.length === 0) return [];
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
    // 让精确叶节点在视口中停留足够久，以等待浏览器 IO 回调和下一轮分时发现任务；
    // 存在嵌套滚动容器时，scrollIntoView 会自然选择最近的一层。
    await page.waitForTimeout(Math.min(dwellMs, Math.max(1, deadline - Date.now())));
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
  const statuses = await page.evaluate(
    ({trackerKey, requestedTokens}) => window[trackerKey]?.missingStatuses?.(requestedTokens) || [],
    {trackerKey: COVERAGE_TRACKER_KEY, requestedTokens: tokens},
  );
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
  } finally {
    await popup.close();
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
    await page.locator(selector).nth(rawIndex).scrollIntoViewIfNeeded();
  } catch (error) {
    const diagnostics = await page.evaluate((targetSelector) => ({
      url: location.href,
      title: document.title,
      selector: targetSelector,
      count: document.querySelectorAll(targetSelector).length,
      bodyText: (document.body?.innerText || '').replace(/\s+/gu, ' ').slice(0, 500),
      samples: [...document.querySelectorAll('main p, article p, h1, h2, [itemprop="description"]')]
        .slice(0, 12).map((node) => ({tag: node.tagName, className: node.className, text: (node.textContent || '').trim().slice(0, 100)})),
    }), selector);
    throw new Error(`${error.message}\n目标 selector 诊断：${JSON.stringify(diagnostics)}`);
  }
  await page.waitForTimeout(1000);
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

async function capturePageContract(
  page,
  requiredSelectors,
  forbiddenSelectors,
  interactionSelectors,
  dynamicForbiddenSelectors,
  optionalForbiddenSelectors,
  mutableForbiddenSelectors = [],
) {
  return page.evaluate(({required, forbidden, interactions, dynamicForbidden, optionalForbidden, mutableForbidden}) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const ownedSelector = [
      '.fluent-read-bilingual-content',
      '.fluent-read-loading',
      '.fluent-read-retry-wrapper',
      '[data-fr-translation-owned="true"]',
    ].join(', ');
    const semanticSnapshot = (node) => {
      if (!node) return {sourceText: '', structure: ''};
      const clone = node.cloneNode(true);
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
    const firstVisibleTextNode = (selector) => [...document.querySelectorAll(selector)].find((node) => {
      if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(node.textContent?.trim());
    });
    const forbiddenSignature = (node) => {
      const visit = (current) => {
        if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.nodeValue) ? '#text' : null;
        if (current.nodeType !== Node.ELEMENT_NODE) return null;
        return [current.tagName.toLowerCase(), [...current.childNodes].map(visit).filter(Boolean)];
      };
      return {
        tagName: node.tagName,
        id: node.id,
        role: node.getAttribute('role') || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        value: 'value' in node ? String(node.value || '') : '',
        text: normalizeText(node.textContent),
        structure: JSON.stringify(visit(node)),
      };
    };
    const forbiddenState = forbidden.map((selector) => {
      const nodes = [...document.querySelectorAll(selector)]
        .filter((node) => !node.closest('.fluent-read-bilingual-content'));
      return {
        selector,
        dynamic: dynamicForbidden.includes(selector),
        optional: optionalForbidden.includes(selector),
        mutable: mutableForbidden.includes(selector),
        count: nodes.length,
        translatedDescendants: nodes.reduce((count, node) =>
          count + node.querySelectorAll('.fluent-read-bilingual-content').length, 0),
        ownedDescendants: nodes.reduce((count, node) => count +
          (node.matches(ownedSelector) ? 1 : 0) + node.querySelectorAll(ownedSelector).length, 0),
        // 契约判断会比较每个禁止节点。快照只在少量固定页面契约阶段采集，
        // 因此对长公式或代码页面执行完整拓扑遍历既有界也必要。
        signatures: nodes.map(forbiddenSignature),
      };
    });
    const requiredState = required.map((selector) => {
      const node = firstVisibleTextNode(selector);
      return {selector, minimumCount: document.querySelectorAll(selector).length, ...semanticSnapshot(node)};
    });
    const interactionState = interactions.map((selector) => {
      const nodes = [...document.querySelectorAll(selector)]
        .filter((node) => !node.closest('.fluent-read-bilingual-content'));
      const node = nodes.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || nodes[0];
      return {
        selector,
        minimumCount: nodes.length,
        tagName: node?.tagName || '',
        href: node instanceof HTMLAnchorElement ? node.href : '',
        type: node && 'type' in node ? String(node.type || '') : '',
        disabled: Boolean(node?.matches?.(':disabled')),
        ariaDisabled: node?.getAttribute?.('aria-disabled') || '',
        role: node?.getAttribute?.('role') || '',
      };
    });
    return {requiredState, forbiddenState, interactionState};
  }, {
    required: requiredSelectors,
    forbidden: forbiddenSelectors,
    interactions: interactionSelectors,
    dynamicForbidden: dynamicForbiddenSelectors,
    optionalForbidden: optionalForbiddenSelectors,
    mutableForbidden: mutableForbiddenSelectors,
  });
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
    const currentSignatures = new Set(current.signatures.map((signature) => JSON.stringify(signature)));
    const missingBaseline = initial.signatures.some((signature) =>
      !currentSignatures.has(JSON.stringify(signature)));
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
  const state = await page.evaluate(({baselineState, required, url}) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const ownedSelector = [
      '.fluent-read-bilingual-content',
      '.fluent-read-loading',
      '.fluent-read-retry-wrapper',
      '[data-fr-translation-owned="true"]',
    ].join(', ');
    const firstVisibleTextNode = (selector) => [...document.querySelectorAll(selector)].find((node) => {
      if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
          Boolean(node.textContent?.trim());
    });
    const forbiddenSignature = (node) => {
      const visit = (current) => {
        if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.nodeValue) ? '#text' : null;
        if (current.nodeType !== Node.ELEMENT_NODE) return null;
        return [current.tagName.toLowerCase(), [...current.childNodes].map(visit).filter(Boolean)];
      };
      return {
        tagName: node.tagName,
        id: node.id,
        role: node.getAttribute('role') || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        value: 'value' in node ? String(node.value || '') : '',
        text: normalizeText(node.textContent),
        structure: JSON.stringify(visit(node)),
      };
    };
    const forbiddenState = baselineState.forbiddenState.map(({selector, dynamic, optional, mutable}) => {
      const nodes = [...document.querySelectorAll(selector)]
        .filter((node) => !node.closest('.fluent-read-bilingual-content'));
      return {
        selector,
        dynamic,
        optional,
        mutable,
        count: nodes.length,
        translatedDescendants: nodes.reduce((count, node) =>
          count + node.querySelectorAll('.fluent-read-bilingual-content').length, 0),
        ownedDescendants: nodes.reduce((count, node) => count +
          (node.matches(ownedSelector) ? 1 : 0) + node.querySelectorAll(ownedSelector).length, 0),
        signatures: nodes.map(forbiddenSignature),
      };
    });
    const requiredState = required.map((selector) => ({
      selector,
      count: document.querySelectorAll(selector).length,
      exists: Boolean(firstVisibleTextNode(selector)),
    }));
    const interactionState = baselineState.interactionState.map(({selector}) => {
      const nodes = [...document.querySelectorAll(selector)]
        .filter((node) => !node.closest('.fluent-read-bilingual-content'));
      const initial = baselineState.interactionState.find((item) => item.selector === selector);
      const matchesInitialIdentity = (candidate) => {
        const href = candidate instanceof HTMLAnchorElement ? candidate.href : '';
        const type = candidate && 'type' in candidate ? String(candidate.type || '') : '';
        return candidate.tagName === initial?.tagName && href === initial?.href && type === initial?.type &&
          (candidate.getAttribute?.('role') || '') === initial?.role;
      };
      const node = nodes.find((candidate) => matchesInitialIdentity(candidate)) || nodes.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || nodes[0];
      const focusable = Boolean(node && !node.matches(':disabled') && (
        node.matches('a[href], button, input, select, textarea, summary, [contenteditable="true"]') ||
        node.tabIndex >= 0
      ));
      return {
        selector,
        count: nodes.length,
        tagName: node?.tagName || '',
        href: node instanceof HTMLAnchorElement ? node.href : '',
        type: node && 'type' in node ? String(node.type || '') : '',
        disabled: Boolean(node?.matches?.(':disabled')),
        ariaDisabled: node?.getAttribute?.('aria-disabled') || '',
        role: node?.getAttribute?.('role') || '',
        connected: Boolean(node?.isConnected),
        focusable,
      };
    });
    return {
      urlUnchanged: location.href === url,
      documentHealthy: document.readyState !== 'loading' && Boolean(document.documentElement?.isConnected) && Boolean(document.body?.isConnected),
      requiredState,
      forbiddenState,
      interactionState,
    };
  }, {baselineState: baseline, required: requiredSelectors, url: expectedUrl});

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
      current.href === initial.href && current.type === initial.type && current.disabled === initial.disabled &&
      current.ariaDisabled === initial.ariaDisabled && current.role === initial.role && current.connected &&
      (current.disabled || current.focusable);
    if (!stable) errors.push(`交互元素失效：${JSON.stringify({before: initial, after: current})}`);
  }
  if (errors.length > 0) throw new Error(`${phase} 页面完整性断言失败：${errors.join('；')}`);
  return state;
}

async function assertRequiredRestored(page, baseline, phase) {
  const restored = await page.evaluate((requiredState) => requiredState.map(({selector}) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const semanticSnapshot = (node) => {
      if (!node) return {sourceText: '', structure: ''};
      const clone = node.cloneNode(true);
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
    const diagnostics = await page.evaluate(({loadingSelector, retrySelector}) => {
      const describe = (node) => ({
        ownerTag: node.parentElement?.tagName || '',
        ownerId: node.parentElement?.id || '',
        ownerClass: typeof node.parentElement?.className === 'string' ? node.parentElement.className : '',
        ownerText: (node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 240),
      });
      return {
        loading: [...document.querySelectorAll(loadingSelector)].map(describe),
        retries: [...document.querySelectorAll(retrySelector)].map(describe),
      };
    }, {loadingSelector: ownedLoading, retrySelector: ownedRetry});
    throw new Error(`${phase} 等待翻译请求结束超时：${error.message}\n${JSON.stringify(diagnostics)}`);
  } finally {
    await page.evaluate((key) => { delete window[key]; }, idleKey).catch(() => {});
  }

  const retries = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => ({
    ownerTag: node.parentElement?.tagName || '',
    ownerId: node.parentElement?.id || '',
    ownerClass: typeof node.parentElement?.className === 'string' ? node.parentElement.className : '',
    ownerText: (node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 240),
  })), ownedRetry);
  if (retries.length > 0) throw new Error(`${phase} 存在终态翻译失败：${JSON.stringify(retries)}`);
}

// 全文翻译使用可视区懒加载。回归时主动滚过页面，触发所有长页面内容块，
// 然后等待插件的进行中任务和 loading 节点都清空，避免只验证到首屏。
async function scrollAndWaitFullPage(page, timeout, scrollContainerSelector, targetSelector) {
  const maxSteps = 320;
  const readScrollState = () => page.evaluate((selector) => {
    const container = selector ? document.querySelector(selector) : null;
    if (selector && !(container instanceof HTMLElement)) {
      throw new Error(`找不到滚动容器：${selector}`);
    }
    const viewport = container instanceof HTMLElement
      ? Math.max(container.clientHeight, 1)
      : Math.max(window.innerHeight || 0, 480);
    const extent = container instanceof HTMLElement
      ? container.scrollHeight
      : Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
    return {
      viewport,
      extent,
      position: container instanceof HTMLElement ? container.scrollTop : window.scrollY,
      maxDistance: Math.max(0, extent - viewport),
    };
  }, scrollContainerSelector || '');
  const moveTo = (position) => page.evaluate(({position: nextPosition, selector}) => {
      const container = selector ? document.querySelector(selector) : null;
      if (container instanceof HTMLElement) {
        container.scrollTop = nextPosition;
        return;
      }
      window.scrollTo(0, nextPosition);
    }, {position, selector: scrollContainerSelector || ''});

  await moveTo(0);
  await page.waitForTimeout(400);
  await observeCoverage(page);

  let step = 0;
  let bottomStableChecks = 0;
  let lastBottomExtent = -1;
  while (step < maxSteps && bottomStableChecks < 2) {
    const before = await readScrollState();
    const remaining = Math.max(0, before.maxDistance - before.position);
    if (remaining <= 4) {
      await page.waitForTimeout(400);
      await observeCoverage(page);
      const after = await readScrollState();
      const stillAtBottom = after.maxDistance - after.position <= 4;
      const extentStable = Math.abs(after.extent - lastBottomExtent) <= 2;
      bottomStableChecks = stillAtBottom && extentStable ? bottomStableChecks + 1 : 0;
      lastBottomExtent = after.extent;
      if (!stillAtBottom) {
        const stepSize = Math.max(Math.floor(after.viewport * 0.65), 320);
        await moveTo(Math.min(after.maxDistance, after.position + stepSize));
      }
    } else {
      bottomStableChecks = 0;
      lastBottomExtent = -1;
      const stepSize = Math.max(Math.floor(before.viewport * 0.65), 320);
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
    while (catchUpSteps < maxSteps && current.maxDistance - current.position > 4) {
      const stepSize = Math.max(Math.floor(current.viewport * 0.65), 320);
      await moveTo(Math.min(current.maxDistance, current.position + stepSize));
      await page.waitForTimeout(400);
      await observeCoverage(page);
      catchUpSteps += 1;
      current = await readScrollState();
    }
    if (catchUpSteps >= maxSteps) {
      throw new Error('全文翻译后页面持续增长，补扫未能在预算内到达底部');
    }
    await waitForTranslationIdle(page, timeout, `长页补扫第 ${round + 1} 轮后`);
  }
  const finalBottom = await readScrollState();
  if (finalBottom.maxDistance - finalBottom.position > 4) {
    throw new Error(`全文翻译后页面仍未覆盖到底部：${JSON.stringify(finalBottom)}`);
  }

  await settleCoverageByReveal(page, timeout, '全文覆盖收敛');

  await page.waitForTimeout(800);
  await page.evaluate((selector) => {
    const container = selector ? document.querySelector(selector) : null;
    if (container instanceof HTMLElement) container.scrollTop = 0;
    else window.scrollTo(0, 0);
  }, scrollContainerSelector || '');

  // 返回首屏会启动新一轮 IntersectionObserver。读取状态前重新暴露目标并等待新的
  // 延迟任务，否则有效的中间状态会被误判为译文丢失。
  await revealFullPageTarget(page, targetSelector);
  await page.waitForFunction(
    (selector) => (document.querySelector(selector)?.querySelectorAll('.fluent-read-bilingual-content').length || 0) >= 1,
    targetSelector,
    {timeout},
  );
  await waitForTranslationIdle(page, timeout, '回到目标后');
  await observeCoverage(page);
  await page.waitForTimeout(300);
}

async function revealFullPageTarget(page, selector) {
  const target = page.locator(selector).first();
  try {
    await target.scrollIntoViewIfNeeded({timeout: 10000});
  } catch {
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

function findHoverTextPointInPage({selector, index}) {
  const target = document.querySelectorAll(selector)[index];
  if (!target?.isConnected) return null;
  const excluded = '[data-fr-translation-owned="true"], .fluent-read-bilingual-content, ' +
    '.fluent-read-loading, .fluent-read-retry-wrapper, [hidden], [aria-hidden="true"], [inert]';
  const walker = document.createTreeWalker(target, 4);
  const candidates = [];
  let textNode;
  let textIndex = 0;
  while ((textNode = walker.nextNode())) {
    const currentIndex = textIndex++;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(excluded) || !textNode.textContent?.trim()) continue;
    const style = getComputedStyle(parent);
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
      const hit = document.elementFromPoint(x, y);
      if (!hit || !target.contains(hit) || hit.closest(excluded) || (hit !== parent && !hit.contains(parent))) continue;
      // 优先原文普通文本，避免把标题末尾的永久链接或双语副本当作手势入口。
      const link = parent.closest('a');
      candidates.push({
        x, y, textIndex: currentIndex,
        text: textNode.textContent,
        rect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height},
        priority: link && link !== target ? 1 : 0,
      });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority);
  return candidates[0] || null;
}

async function waitForHoverPointer(page, targetConfig, timeout) {
  const started = Date.now();
  let previous;
  let stableSince = started;
  while (Date.now() - started < timeout) {
    const point = await page.evaluate(findHoverTextPointInPage, targetConfig);
    const stable = point && previous && point.textIndex === previous.textIndex && point.text === previous.text &&
      ['left', 'top', 'width', 'height'].every((key) => Math.abs(point.rect[key] - previous.rect[key]) < 0.5) &&
      Math.abs(point.x - previous.x) < 0.5 && Math.abs(point.y - previous.y) < 0.5;
    if (!stable) {
      stableSince = Date.now();
      if (point) await page.mouse.move(point.x, point.y);
    } else if (Date.now() - stableSince >= 200) {
      return point;
    }
    previous = point;
    await page.waitForTimeout(50);
  }
  throw new Error(`悬浮原文没有稳定且可命中的位置：${JSON.stringify({targetConfig, lastPoint: previous})}`);
}

async function toggleHover(page, target, targetConfig, expectedCount, timeout) {
  const {selector, index} = targetConfig;
  await target.scrollIntoViewIfNeeded();
  // 还原译文会改变布局，宿主也可能继续滚动或播放入场动画。固定等待后取外框
  // 坐标会落到空白容器；按键前等待真实原文行稳定并保持命中，按键只发送一次。
  const {x, y} = await waitForHoverPointer(page, targetConfig, timeout);
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
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
    throw new Error(`${error.message}\n悬浮 case 诊断（期望 wrapper=${expectedCount}）：${JSON.stringify(diagnostics)}`);
  }
}

function findHoverTargetInPage({
  selector,
  eligibleIndex,
  sourceIncludes,
  excludedSelector,
  protectedSelector,
  technicalWords,
}) {
  const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
  const technicalWordSet = new Set(technicalWords);
  const naturalLanguage = (text) => {
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
    const clone = node.cloneNode(true);
    clone.querySelectorAll(
      `.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, ` +
      `[data-fr-translation-owned="true"], ${protectedSelector}`,
    ).forEach((protectedNode) => protectedNode.remove());
    return normalizeText(clone.textContent);
  };
  const raw = [...document.querySelectorAll(selector)];
  const matches = raw.map((node, rawIndex) => ({node, rawIndex, text: sourceText(node)})).filter(({node, text}) => {
    if (!(node instanceof HTMLElement) || node.closest(excludedSelector)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
      naturalLanguage(text) && sourceIncludes.every((fragment) => text.includes(fragment));
  });
  const result = matches[eligibleIndex] || null;
  return result ? {rawIndex: result.rawIndex, sourceText: result.text} : null;
}

async function resolveHoverTarget(page, targetConfig, timeout) {
  const argument = {
    selector: targetConfig.selector,
    eligibleIndex: targetConfig.index,
    sourceIncludes: targetConfig.sourceIncludes || [],
    excludedSelector: COVERAGE_EXCLUDED_ANCESTORS,
    protectedSelector: COVERAGE_PROTECTED_DESCENDANTS,
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
  await page.keyboard.down('Alt');
  await page.keyboard.press('t');
  await page.keyboard.up('Alt');
}

async function closeInteractionDialog(page, scenario, timeout, phase) {
  const attemptTimeout = Math.min(timeout, INTERACTION_CLOSE_ATTEMPT_TIMEOUT);
  let lastError;
  for (let attempt = 1; attempt <= scenario.closeAttempts; attempt += 1) {
    await page.keyboard.press(scenario.closeKey);
    try {
      await page.waitForSelector(scenario.dialogSelector, {state: 'hidden', timeout: attemptTimeout});
      return attempt;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${phase}/${scenario.name} 对话框在 ${scenario.closeAttempts} 次 ${scenario.closeKey} 后仍未隐藏` +
    (lastError?.message ? `：${lastError.message}` : ''),
  );
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
      await page.locator(scenario.triggerSelector).first().click();
    } else {
      await page.keyboard.press(scenario.openKey);
    }
    await page.waitForSelector(scenario.dialogSelector, {state: 'visible', timeout});
    const dialogLocator = page.locator(scenario.dialogSelector).first();
    const comboboxLocator = dialogLocator.locator(scenario.comboboxSelector).first();
    await comboboxLocator.waitFor({state: 'visible', timeout});
    if (scenario.inputText) await comboboxLocator.fill(scenario.inputText);
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
    await page.screenshot({path: outputPath, fullPage: false, timeout: 10000});
  } catch (error) {
    process.stderr.write(`证据截图失败（不影响 DOM/交互断言）：${error.message}\n`);
  }
}

async function runHoverCase(page, hoverTargets, requiredSelectors, pageContract, timeout, artifactsDir) {
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

    for (const expected of [1, 0, 1]) {
      await toggleHover(page, target, runtimeTargetConfig, expected, timeout);
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
      if (expected === 0) await assertRequiredRestored(page, pageContract, `${targetConfig.name} 悬浮恢复`);
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
    });

    // 为下一个语义类型清场，避免前一个 H1 的译文让全局 wrapper 计数
    // 掩盖 H2/P/LI 的真实命中结果。最后一个目标保留最终 [1] 状态。
    if (targetNumber < hoverTargets.length - 1) {
      await toggleHover(page, target, runtimeTargetConfig, 0, timeout);
      await assertWrapperUniqueness(page, 0, `${targetConfig.name} 悬浮目标清场`);
      await assertRequiredRestored(page, pageContract, `${targetConfig.name} 悬浮目标清场`);
    }
  }

  return {
    hoverTargets: results,
    counts: results[0]?.counts || [],
    neighborCounts: results[0]?.neighborCounts || [],
    translationText: results[0]?.translationText || '',
  };
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
    timeout,
    artifactsDir,
    initialUrl,
  } = context;
  const first = pass === 'first';
  const phase = first ? '全文首次翻译' : '全文再次翻译';

  await toggleFull(page);
  reportProgress(first ? '已触发首次全文翻译' : '已触发第二次全文翻译');
  await revealFullPageTarget(page, selector);
  try {
    await page.waitForFunction(
      (targetSelector) => (document.querySelector(targetSelector)
        ?.querySelectorAll('.fluent-read-bilingual-content').length || 0) >= 1,
      selector,
      {timeout},
    );
  } catch (error) {
    if (!first) throw error;
    const diagnostics = await page.evaluate((targetSelector) => {
      const targetNode = document.querySelector(targetSelector);
      return {
        totalBilingual: document.querySelectorAll('.fluent-read-bilingual-content').length,
        targetText: targetNode?.textContent?.trim() || '',
        targetBilingual: targetNode?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
        targetLoading: targetNode?.querySelectorAll('.fluent-read-loading').length || 0,
        targetRetry: targetNode?.querySelectorAll('.fluent-read-retry-wrapper').length || 0,
        translatedNodes: [...document.querySelectorAll('.fluent-read-bilingual-content')].map((node) => ({
          text: node.textContent?.trim() || '',
          parent: node.parentElement?.outerHTML.slice(0, 500) || '',
        })),
        bodyText: (document.body?.innerText || '').slice(0, 1000),
      };
    }, selector);
    throw new Error(`${error.message}\n全文 case 诊断：${JSON.stringify(diagnostics)}`);
  }

  const target = await readTargetState(page, selector);
  if (first) reportProgress('首次目标已翻译，开始滚动页面主滚动面');
  if (target.bilingualCount < 1 || !target.translationTexts.every((text) => /[\u3400-\u9fff]/u.test(text))) {
    throw new Error(`${first ? '全文首次翻译状态异常' : '全文再次翻译状态异常'}：${JSON.stringify(target)}`);
  }
  await scrollAndWaitFullPage(page, timeout, scrollContainer, selector);
  const pageState = await readFullPageState(
    page,
    selector,
    requiredSelectors,
    fullCoverageSelectors,
    controlSelector,
  );
  const coverage = await readCoverageReport(page);
  reportProgress(`${first ? '首次全文稳定' : '第二次全文稳定'}：${pageState.totalBilingual} 个 wrapper`);
  if (pageState.targetBilingual < 1 || pageState.totalBilingual < 1 ||
      pageState.uniqueWrapperParents !== pageState.totalBilingual ||
      pageState.requiredBilingual.some((item) => item.bilingualCount < 1 ||
        item.translationTexts.some((text) => !/[\u3400-\u9fff]/u.test(text))) ||
      pageState.fullCoverage.some((item) => item.visibleCount < 1 || item.translatedCount !== item.visibleCount)) {
    const message = first ? '全文滚动后状态异常' : '全文再次滚动后状态异常';
    throw new Error(`${message}：${JSON.stringify(pageState)}`);
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
  return {target, pageState, coverage, interactions};
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
  timeout,
  artifactsDir,
) {
  const initialUrl = page.url();
  const baselineInteractionScenarios = await runInteractionScenarios(
    page,
    interactionScenarios,
    timeout,
    '全文翻译前基线',
  );
  const runtimeCoverageRules = withMandatoryHeadingCoverage(coverageRules);
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
    timeout,
    artifactsDir,
    initialUrl,
  };
  const firstPass = await runFullTranslationPass(passContext, 'first');

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
  await resetCoverageTracker(page);
  reportProgress('全文恢复完成');

  const secondPass = await runFullTranslationPass(passContext, 'second');
  return {
    translated: firstPass.target,
    translatedPage: firstPass.pageState,
    coverage: firstPass.coverage,
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
  const extensionDir = path.resolve(args.extensionDir);
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('插件 manifest.json 不存在');
  assertFreshProductionExtension(extensionDir);
  if (!fs.existsSync(args.browserPath)) throw new Error(`浏览器不存在：${args.browserPath}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-site-case-'));
  assertDedicatedProfile(profileDir);
  const artifactsDir = args.artifactsDir ? path.resolve(args.artifactsDir) : null;
  if (artifactsDir) fs.mkdirSync(artifactsDir, {recursive: true});
  const {chromium} = loadPlaywright(args.playwrightRoot);
  const focusSafeHelper = loadFocusSafeHelper(args.focusSafeHelper);
  const viewport = {width: 1280, height: 900};
  const browserArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const createPage = focusSafeHelper
    ? focusSafeHelper.newPageWithoutForeground
    : async (targetContext) => targetContext.newPage();
  const activateTab = focusSafeHelper
    ? focusSafeHelper.activateExtensionTabWithoutForeground
    : async () => undefined;
  let context;
  let launched;
  try {
    if (focusSafeHelper) {
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
    } else {
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
    const page = await createPage(context, args.timeout);
    await page.goto(args.url, {waitUntil: 'domcontentloaded', timeout: args.timeout});
    await activateTab(context, page, args.timeout);
    reportProgress(`${args.case}/${args.mode} 页面已加载`);
    // 当前 main 默认关闭悬浮球，但 Control/Alt+T 快捷键仍独立工作；
    // 这里等待 content script 初始化，而不是要求 UI 浮球必须存在。
    await page.waitForTimeout(1000);
    if (args.prepareScrollSelector) {
      // Some landing pages reveal existing DOM only after it enters the viewport.
      // Use normal browser scrolling; never remove the site's hidden markers.
      await page.locator(args.prepareScrollSelector).first().scrollIntoViewIfNeeded({timeout: args.timeout});
      reportProgress(`页面预滚动已完成：${args.prepareScrollSelector}`);
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
    const config = configResult.config || {};
    const expectedHotkey = args.mode === 'hover' ? args.hoverHotkey : args.fullPageHotkey;
    if (config.service !== args.service) throw new Error(`服务不符：预期 ${args.service}，实际 ${config.service}`);
    if (Number(config.display) !== 1) throw new Error(`预期双语模式 display=1，实际 ${config.display}`);
    if (args.mode === 'hover' && config.hotkey !== expectedHotkey) throw new Error(`悬浮快捷键不符：${config.hotkey}`);
    if (args.mode === 'full' && config.floatingBallHotkey !== expectedHotkey) throw new Error(`全文快捷键不符：${config.floatingBallHotkey}`);
    reportProgress(`${args.case}/${args.mode} 页面 contract 与扩展配置已就绪`);

    const result = args.mode === 'hover'
      ? await runHoverCase(
        page,
        args.hoverTargets,
        args.requiredSelectors,
        pageContract,
        args.timeout,
        artifactsDir,
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
        args.timeout,
        artifactsDir,
      );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      case: args.case,
      mode: args.mode,
      hostMathRendering,
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
    }, null, 2)}\n`);
  } finally {
    if (launched?.close) {
      await launched.close().catch(() => {});
    } else if (context) {
      await context.close().catch(() => {});
    }
    fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
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
  waitForHostMathRendering,
  observeTranslationIdleInPage,
  waitForTranslationIdle,
  waitForStableTarget,
  withMandatoryHeadingCoverage,
};
