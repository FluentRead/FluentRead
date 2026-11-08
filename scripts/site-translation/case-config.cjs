'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {isSupportedFacebookPublicPostUrl} = require('./facebook-public-post-preparation.cjs');

const CASES_PATH = path.join(__dirname, '..', '..', 'tests', 'browser-translation-cases.json');
const CASES = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));

const MAX_INTERACTION_CLOSE_ATTEMPTS = 3;
const HOST_MUTABLE_FORBIDDEN_SELECTORS = new Set(['.MathJax_Display']);
const MATRIX_REQUIREMENTS = Object.freeze({
  total: 35,
  required: 27,
  requiredHosts: 23,
  quarantine: 2,
  h1CoverageRules: 8,
  dynamicCoverageRules: 3,
});

function normalizeSelectorList(value, fallback) {
  const raw = Array.isArray(value) ? value : value ? [value] : fallback ? [fallback] : [];
  return [...new Set(raw.map((selector) => String(selector).trim()).filter(Boolean))];
}

function normalizeDismissiblePromotion(value) {
  if (value === undefined) return undefined;
  const fields = ['dialogSelector', 'buttonSelector', 'contentSelector'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key) && key !== 'waitForDialogMs') ||
      fields.some(key => !Object.prototype.hasOwnProperty.call(value, key) ||
        typeof value[key] !== 'string' || !value[key].trim())) {
    throw new Error('prepareDismissiblePromotion 必须声明非空字符串 dialogSelector/buttonSelector/contentSelector');
  }
  const {waitForDialogMs} = value;
  if (waitForDialogMs !== undefined && (!Number.isInteger(waitForDialogMs) || waitForDialogMs <= 0 || waitForDialogMs > 15000)) {
    throw new Error('prepareDismissiblePromotion.waitForDialogMs 必须是 1-15000 的整数');
  }
  return {...Object.fromEntries(fields.map(key => [key, value[key].trim()])),
    ...(waitForDialogMs === undefined ? {} : {waitForDialogMs})};
}

function normalizeFacebookPublicPostPreparation(value) {
  if (value === undefined) return undefined;
  if (value !== true) throw new Error('prepareFacebookPublicPost 必须为 true，且仅用于已核对的公开帖子准备流程');
  return true;
}

function normalizeSourcePartition(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'excludeSelectors') || !Array.isArray(value.excludeSelectors) ||
      value.excludeSelectors.some(selector => typeof selector !== 'string' || !selector.trim())) {
    throw new Error('sourcePartition 必须仅声明 excludeSelectors selector 数组');
  }
  return {excludeSelectors: normalizeSelectorList(value.excludeSelectors)};
}

function validateMutableForbiddenSelectors(caseName, forbiddenSelectors, dynamicForbiddenSelectors, mutableSelectors) {
  const invalid = mutableSelectors.filter((selector) =>
    !HOST_MUTABLE_FORBIDDEN_SELECTORS.has(selector) ||
    !forbiddenSelectors.includes(selector) || !dynamicForbiddenSelectors.includes(selector));
  if (invalid.length > 0) {
    throw new Error(`case ${caseName} 的 mutableForbiddenSelectors 必须同时是` +
      `允许列表、dynamicForbiddenSelectors 与 forbiddenSelectors 的子集：${invalid.join(', ')}`);
  }
}

function resolveForbiddenMustExistSelectors(
  tier,
  forbiddenSelectors,
  configuredSelectors = [],
  optionalSelectors = [],
) {
  const optional = new Set(optionalSelectors);
  const required = tier === 'required' ? forbiddenSelectors : configuredSelectors;
  return required.filter((selector) => !optional.has(selector));
}

function normalizeHoverTargets(value, options = {}) {
  const legacyFallback = typeof options === 'string' ? options : options.fallbackSelector;
  const coverageRules = Array.isArray(options?.coverageRules) ? options.coverageRules : [];
  const source = Array.isArray(value) && value.length > 0
    ? value
    : legacyFallback
      ? [{name: 'primary', selector: legacyFallback, index: 0}]
      : [];
  const normalized = source.map((target, index) => {
    const selector = String(target?.selector || '').trim();
    const matchingRule = coverageRules.find((rule) => rule.selector === selector);
    const sourceIncludes = Object.prototype.hasOwnProperty.call(target || {}, 'sourceIncludes')
      ? normalizeSelectorList(target.sourceIncludes)
      : normalizeSelectorList(matchingRule?.sourceIncludes).slice(0, 1);
    if (target?.textIncludes !== undefined && (!Array.isArray(target.textIncludes) || !target.textIncludes.length ||
        target.textIncludes.some(value => typeof value !== 'string' || !value.trim()))) {
      throw new Error('hover target textIncludes 必须是非空原文 Text 片段数组');
    }
    const sourcePartition = normalizeSourcePartition(target?.sourcePartition ?? matchingRule?.sourcePartition);
    return {
      name: String(target?.name || `target-${index + 1}`).trim(),
      selector,
      index: target?.index === undefined ? 0 : Number(target.index),
      sourceIncludes,
      ...(target?.textIncludes === undefined ? {} : {textIncludes: normalizeSelectorList(target.textIncludes)}),
      ...(sourcePartition ? {sourcePartition} : {}),
    };
  }).filter((target) => target.name && target.selector && Number.isInteger(target.index) && target.index >= 0);
  const selectors = new Set(normalized.map(({selector}) => selector));
  for (const rule of coverageRules) {
    if (selectors.has(rule.selector)) continue;
    normalized.push({
      name: `coverage-${rule.name}`,
      selector: rule.selector,
      index: 0,
      sourceIncludes: rule.sourceIncludes.slice(0, 1),
      ...(rule.sourcePartition ? {sourcePartition: rule.sourcePartition} : {}),
    });
    selectors.add(rule.selector);
  }
  return normalized;
}

function normalizeInteractionScenarios(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((scenario, index) => ({
    name: String(scenario?.name || `scenario-${index + 1}`).trim(),
    triggerSelector: String(scenario?.triggerSelector || '').trim(),
    openKey: String(scenario?.openKey || '').trim(),
    dialogSelector: String(scenario?.dialogSelector || '').trim(),
    comboboxSelector: String(scenario?.comboboxSelector || '[role="combobox"]').trim(),
    listboxSelector: String(scenario?.listboxSelector || '[role="listbox"]').trim(),
    inputText: String(scenario?.inputText || '').trim(),
    closeKey: String(scenario?.closeKey || 'Escape').trim(),
    closeAttempts: scenario?.closeAttempts === undefined ? 1 : Number(scenario.closeAttempts),
  })).filter((scenario) => scenario.name && scenario.triggerSelector && scenario.openKey && scenario.dialogSelector);
  const invalid = normalized.find(({closeAttempts}) =>
    !Number.isInteger(closeAttempts) || closeAttempts < 1 || closeAttempts > MAX_INTERACTION_CLOSE_ATTEMPTS);
  if (invalid) {
    throw new Error(`interaction scenario ${invalid.name} 的 closeAttempts 必须是 ` +
      `1-${MAX_INTERACTION_CLOSE_ATTEMPTS} 的整数`);
  }
  return normalized;
}

function normalizeCoverageRules(value, legacySelectors = []) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : normalizeSelectorList(legacySelectors).map((selector, index) => ({
      name: `legacy-${index + 1}`,
      selector,
      kind: 'content',
      minInitial: 1,
      minSeen: 1,
      trackDynamic: false,
    }));
  return source.map((rule, index) => ({
    name: String(rule?.name || `coverage-${index + 1}`).trim(),
    selector: String(rule?.selector || '').trim(),
    kind: rule?.kind || 'content',
    minInitial: rule?.minInitial === undefined ? 1 : Number(rule.minInitial),
    minSeen: rule?.minSeen === undefined
      ? (rule?.minInitial === undefined ? 1 : Number(rule.minInitial))
      : Number(rule.minSeen),
    trackDynamic: rule?.trackDynamic === true,
    ...(rule?.minTextLength === undefined ? {} : {minTextLength: Number(rule.minTextLength)}),
    sourceIncludes: normalizeSelectorList(rule?.sourceIncludes),
    ...(rule?.sourcePartition === undefined ? {} : {sourcePartition: normalizeSourcePartition(rule.sourcePartition)}),
  }));
}

function validateCoverageRules(caseName, rules, options = {}) {
  const errors = [];
  if (options.requireExplicit && (!Array.isArray(options.explicitRules) || options.explicitRules.length === 0)) {
    errors.push(`${caseName} 的 required case 必须显式配置 coverageRules`);
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    errors.push(`${caseName} 至少需要一条 coverageRules`);
    return errors;
  }
  const names = new Set();
  for (const [index, rule] of rules.entries()) {
    const label = `${caseName}.coverageRules[${index}]`;
    if (!rule.name) errors.push(`${label} 缺少 name`);
    if (names.has(rule.name)) errors.push(`${label} name 重复：${rule.name}`);
    names.add(rule.name);
    if (!rule.selector) errors.push(`${label} 缺少 selector`);
    // 每条规则必须描述一个清晰的语义区域。禁止用逗号把标题、正文和列表
    // 混成一个 selector，否则“只命中 union 中的一个节点”仍可能误通过。
    if (rule.selector.includes(',')) errors.push(`${label} selector 不得包含逗号，请拆成独立覆盖规则`);
    if (!['heading', 'content', 'list', 'control'].includes(rule.kind)) {
      errors.push(`${label} kind 必须是 heading/content/list/control`);
    }
    if (!Number.isInteger(rule.minInitial) || rule.minInitial < 1) {
      errors.push(`${label} minInitial 必须是正整数`);
    }
    if (!Number.isInteger(rule.minSeen) || rule.minSeen < rule.minInitial) {
      errors.push(`${label} minSeen 必须是大于等于 minInitial 的整数`);
    }
    if (rule.minTextLength !== undefined && (!Number.isInteger(rule.minTextLength) || rule.minTextLength < 0)) {
      errors.push(`${label} minTextLength 必须是非负整数`);
    }
    if (rule.kind === 'heading' && !/\bh[1-6]\b/iu.test(rule.selector)) {
      errors.push(`${label} heading 规则必须显式选择 h1-h6`);
    }
    if (rule.sourceIncludes.some((value) => !value.trim())) {
      errors.push(`${label} sourceIncludes 不得包含空字符串`);
    }
    if (rule.sourcePartition && rule.trackDynamic) {
      errors.push(`${label} sourcePartition 固定基线不得启用 trackDynamic`);
    }
  }
  return errors;
}

function normalizeCaseConfig(caseName, caseConfig) {
  const tier = caseConfig.tier || 'required';
  const requiredSelectors = normalizeSelectorList(caseConfig.requiredSelectors, caseConfig.selector);
  const forbiddenSelectors = normalizeSelectorList(caseConfig.forbiddenSelectors);
  const optionalForbiddenSelectors = normalizeSelectorList(caseConfig.optionalForbiddenSelectors);
  const configuredForbiddenMustExistSelectors = normalizeSelectorList(caseConfig.forbiddenMustExistSelectors);
  const forbiddenMustExistSelectors = resolveForbiddenMustExistSelectors(
    tier,
    forbiddenSelectors,
    configuredForbiddenMustExistSelectors,
    optionalForbiddenSelectors,
  );
  const dynamicForbiddenSelectors = normalizeSelectorList(caseConfig.dynamicForbiddenSelectors);
  const mutableForbiddenSelectors = normalizeSelectorList(caseConfig.mutableForbiddenSelectors);
  const fullCoverageSelectors = normalizeSelectorList(caseConfig.fullCoverageSelectors);
  const coverageRules = normalizeCoverageRules(caseConfig.coverageRules, fullCoverageSelectors);
  const hoverTargets = normalizeHoverTargets(caseConfig.hoverTargets, {
    fallbackSelector: caseConfig.hoverSelector || caseConfig.selector || requiredSelectors[0],
    coverageRules,
  });

  return {
    selector: caseConfig.hoverSelector || caseConfig.selector || requiredSelectors[0],
    ...(caseConfig.prepareDismissiblePromotion === undefined ? {} : {
      prepareDismissiblePromotion: normalizeDismissiblePromotion(caseConfig.prepareDismissiblePromotion),
    }),
    ...(caseConfig.prepareFacebookPublicPost === undefined ? {} : {
      prepareFacebookPublicPost: normalizeFacebookPublicPostPreparation(caseConfig.prepareFacebookPublicPost),
    }),
    ...(typeof caseConfig.prepareScrollSelector === 'string' && caseConfig.prepareScrollSelector.trim()
      ? {prepareScrollSelector: caseConfig.prepareScrollSelector.trim()} : {}),
    ...(caseConfig.hoverSettleMs !== undefined ? {hoverSettleMs: caseConfig.hoverSettleMs} : {}),
    requiredSelectors,
    forbiddenSelectors,
    optionalForbiddenSelectors,
    forbiddenMustExistSelectors,
    dynamicForbiddenSelectors,
    mutableForbiddenSelectors,
    fullCoverageSelectors,
    coverageRules,
    fullPageScope: caseConfig.fullPageScope ?? 'finite-page',
    hoverTargets,
    interactionSelectors: normalizeSelectorList(caseConfig.interactionSelectors),
    interactionScenarios: normalizeInteractionScenarios(caseConfig.interactionScenarios),
    modes: Array.isArray(caseConfig.modes) ? caseConfig.modes : ['hover', 'full'],
    tier,
  };
}

function collectBaseCaseConfigErrors(caseName, caseConfig, normalized = normalizeCaseConfig(caseName, caseConfig)) {
  const errors = [];
  if (caseConfig.prepareFacebookPublicPost !== undefined) {
    if (!isSupportedFacebookPublicPostUrl(caseConfig.url)) {
      errors.push(`${caseName} 的 prepareFacebookPublicPost 仅支持 https://www.facebook.com 的公开 posts URL`);
    }
    if (caseConfig.prepareClickText !== undefined || caseConfig.prepareDismissiblePromotion !== undefined) {
      errors.push(`${caseName} 的 prepareFacebookPublicPost 不得与其他推广关闭动作同时使用`);
    }
  }
  if (caseConfig.prepareDismissiblePromotion !== undefined && caseConfig.prepareClickText !== undefined) {
    errors.push(`${caseName} 的 prepareDismissiblePromotion 不得与 prepareClickText 同时使用`);
  }
  if (!['finite-page', 'initial-corpus'].includes(normalized.fullPageScope)) {
    errors.push(`${caseName} 的 fullPageScope 必须是 finite-page 或 initial-corpus`);
  }
  if (normalized.fullPageScope === 'initial-corpus' && normalized.coverageRules.some(rule => rule.trackDynamic)) {
    errors.push(`${caseName} 的 initial-corpus 不得启用 trackDynamic，避免把无限新增正文当作有限覆盖集合`);
  }
  if (caseConfig.prepareScrollSelector !== undefined &&
      (typeof caseConfig.prepareScrollSelector !== 'string' || !caseConfig.prepareScrollSelector.trim())) {
    errors.push(`${caseName} 的 prepareScrollSelector 必须是非空 selector`);
  }
  if (caseConfig.hoverSettleMs !== undefined && (!Number.isInteger(caseConfig.hoverSettleMs) ||
      caseConfig.hoverSettleMs < 0 || caseConfig.hoverSettleMs > 5000)) {
    errors.push(`${caseName} 的 hoverSettleMs 必须是 0-5000 的整数`);
  }
  const configuredRequiredSelectors = caseConfig.requiredSelectors ||
    (caseConfig.selector ? [caseConfig.selector] : []);
  const rawRequiredSelectors = Array.isArray(configuredRequiredSelectors)
    ? configuredRequiredSelectors
    : [configuredRequiredSelectors];
  if (rawRequiredSelectors.length === 0 ||
      rawRequiredSelectors.some((selector) => !String(selector).trim())) {
    errors.push(`${caseName} 必须配置 requiredSelectors 或旧版 selector`);
  }
  if (caseConfig.hoverTargets && (!Array.isArray(caseConfig.hoverTargets) || caseConfig.hoverTargets.length === 0 ||
      caseConfig.hoverTargets.some((target) => !target?.name || !target?.selector ||
        (target.index !== undefined && (!Number.isInteger(target.index) || target.index < 0))))) {
    errors.push(`${caseName} 的 hoverTargets 必须是包含 name/selector/非负 index 的非空数组`);
  }
  const rawForbiddenSelectors = Array.isArray(caseConfig.forbiddenSelectors) ? caseConfig.forbiddenSelectors : [];
  if (!Array.isArray(caseConfig.forbiddenSelectors) || rawForbiddenSelectors.length === 0 ||
      normalized.forbiddenSelectors.length === 0) errors.push(`${caseName} 缺少 forbiddenSelectors`);
  const rawDynamicForbiddenSelectors = Array.isArray(caseConfig.dynamicForbiddenSelectors)
    ? caseConfig.dynamicForbiddenSelectors
    : [];
  for (const [field, allowEmpty, validSelector, message] of [
    ['optionalForbiddenSelectors', false, (selector) => rawForbiddenSelectors.includes(selector),
      '必须是 forbiddenSelectors 的非空子集'],
    ['dynamicForbiddenSelectors', true, (selector) => rawForbiddenSelectors.includes(selector),
      '必须是 forbiddenSelectors 的子集'],
    ['mutableForbiddenSelectors', false, (selector) => HOST_MUTABLE_FORBIDDEN_SELECTORS.has(selector) &&
      rawForbiddenSelectors.includes(selector) && rawDynamicForbiddenSelectors.includes(selector),
      '必须是允许列表、dynamicForbiddenSelectors 与 forbiddenSelectors 的非空子集'],
    ['forbiddenMustExistSelectors', false, (selector) => rawForbiddenSelectors.includes(selector),
      '必须是 forbiddenSelectors 的非空子集'],
    ['fullCoverageSelectors', false, null, '必须是非空数组'],
  ]) {
    const value = caseConfig[field];
    if (value && (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
        (validSelector && value.some((selector) => !validSelector(selector))))) {
      errors.push(`${caseName} 的 ${field} ${message}`);
    }
  }
  if (caseConfig.interactionScenarios && (!Array.isArray(caseConfig.interactionScenarios) ||
      caseConfig.interactionScenarios.length === 0 || caseConfig.interactionScenarios.some((scenario) =>
        !scenario?.name || !scenario?.triggerSelector || !scenario?.openKey || !scenario?.dialogSelector ||
        !scenario?.comboboxSelector || !scenario?.listboxSelector || !scenario?.inputText ||
        (scenario.closeAttempts !== undefined && (!Number.isInteger(scenario.closeAttempts) ||
          scenario.closeAttempts < 1 || scenario.closeAttempts > MAX_INTERACTION_CLOSE_ATTEMPTS))))) {
    errors.push(`${caseName} 的 interactionScenarios 必须声明 trigger/dialog/combobox/listbox/inputText，` +
      `且 closeAttempts 必须是 1-${MAX_INTERACTION_CLOSE_ATTEMPTS} 的整数`);
  }
  if (!Array.isArray(caseConfig.interactionSelectors) || caseConfig.interactionSelectors.length === 0) {
    errors.push(`${caseName} 缺少 interactionSelectors`);
  }
  errors.push(...validateCoverageRules(caseName, normalized.coverageRules, {
    requireExplicit: normalized.tier === 'required',
    explicitRules: caseConfig.coverageRules,
  }));
  if (normalized.hoverTargets.length === 0) errors.push(`${caseName} 至少需要一个 hover target`);
  if (caseConfig.skipUnscopedH1Coverage === true && !normalized.coverageRules.some((rule) =>
    rule.kind === 'heading' && /\bh1\b/iu.test(rule.selector))) {
    errors.push(`${caseName} 跳过全局 H1 时必须有明确的 H1 正文覆盖规则`);
  }
  return errors;
}

module.exports = {
  CASES,
  CASES_PATH,
  HOST_MUTABLE_FORBIDDEN_SELECTORS,
  MATRIX_REQUIREMENTS,
  MAX_INTERACTION_CLOSE_ATTEMPTS,
  collectBaseCaseConfigErrors,
  normalizeCaseConfig,
  normalizeDismissiblePromotion,
  normalizeFacebookPublicPostPreparation,
  normalizeCoverageRules,
  normalizeHoverTargets,
  normalizeInteractionScenarios,
  normalizeSelectorList,
  resolveForbiddenMustExistSelectors,
  validateCoverageRules,
  validateMutableForbiddenSelectors,
};
