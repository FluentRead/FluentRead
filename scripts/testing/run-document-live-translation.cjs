#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-document-live-translation.cjs
 * 文件职责：在独立生产 Edge 配置中真实验证免费服务翻译普通文档、PDF 阅读与左右对照导出。
 * 主要内容：复用后台焦点保护启动器与原生激活事件观察器，只设置免费服务与英译中公开选项；按输入文件逐份导入、真实翻译、阅读、下载，保存完整段落、状态、脱敏网络统计和截图。PDF 用 PDF.js 重开校验页数、左右对照尺寸与页序，再用 Poppler 渲染；--readable-pdf-first 在首份 PDF 同次真实译文上另验可复制重排导出、逐段中文文字层及首页/尾页图片。普通格式重新解析下载文件，DOCX/ePub 解包核对译文、结构与图片。默认运行实际 Attention 15 页、仓库八种普通格式及英文产品指南，--inputs 可缩小范围。Markdown 严格核对代码、链接、译文强调及指南容器、组件标记，以 VitePress 已有 markdown-it 的标准强调节点核对实际下载（先扣除原文节点，不能只数星号或用产品预览证明译文格式），并按源文本与同一标签检查两项已确认的内部英文残留回归；仅读取这些内容，不执行组件。
 * 交互验证：--exercise-pdf-ui 在首份实际 PDF 上保存首页扫描说明，经 CDP 键盘 Tab/Enter/Space 选择原生菜单按钮，验证受控 Ctrl/Cmd wheel 的文档缩放、指针锚点及键盘复位；真实译文完成后切换显示方式，恢复原版对照和适合整页，再执行既有小屏阅读与下载验收。这些事件不代表物理触控板实测。
 * 词库验证：可选 --builtin-glossary ai-en-zh-hans 从本生产包的设置界面导入可编辑副本，启用总开关，再通过公开配置端口只选择该真实库 ID；保存启用状态、来源版本、词条数及文档选择，不读取词条作为测试预期或输出其它配置。无参数时只记录实际公开状态。
 * 恢复验证：--translation-resumes 0..3 默认关闭，读取当前恢复提示及兼容旧提示，仅在实际翻译中断且错误为请求超时时点击同工具栏“重试”或“继续翻译”，记录实际按钮名称，禁止重新翻译。每次保存原错误、部分译文和截图，保留停止批次首编号而不归因该段；原翻译总截止不重置，设置和所有已完成译文必须保持不变。恢复后完成仍明确记录曾失败，不能视作一次无失败完成。
 * 诊断收尾：响应正文观察每条最多等五秒，记录超时/失败并拒绝晚到正文回填；文档失败先保存状态，批次诊断与最终清理各有截止。HTTP 证据按固定翻译端点辨认 Microsoft/Google 有序原生槽位、单文本与未知请求；仅完整多槽响应进入已完成合批统计，不把同域 2xx 或背景消息数组当作合批。
 * 模块边界：不创建请求路由、不替换 fetch、不伪造译文、不配置付费账户，不读取或输出任何凭据；只使用本次新建的临时浏览器配置，不操作用户浏览器。中文及无测试标记只能证明实际结果，译文质量和排版需结合保存的数据与图片人工复核。
 */
const assert = require('node:assert/strict');
const {mapPdfLayoutPages} = require('./pdf-output-pages.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication, startFocusEventMonitor} = require('./focus-safe-browser.cjs');
const {getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const {decodeHttpTranslationRequest, decodeHttpTranslationResponse, summarizeHttpEvidence} = require('./document-live-http-evidence.cjs');

const arg = (name, fallback) => {const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1];};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const slug = value => value.replace(/[^\p{L}\p{N}._-]+/gu, '-');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const compact = value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const MOCK_MARKER = /BENCH_[a-f\d]|___FLUENTREAD_|__FRTERM_|SOURCE_BEGIN|SOURCE_END|测试译文[：:]/u;
const FREE_DOMAINS = ['microsoft.com', 'google.com', 'google.co.uk', 'googleapis.com', 'bilibili.com', 'qq.com', 'volcengine.com', 'volces.com', 'youdao.com', 'iciba.com', 'yandex.net', 'yandex.com', 'translated.net', 'reverso.net', 'apertium.org', 'alibaba.com', 'modernmt.com', 'laratranslate.com', 'lingvanex.com'];
const isProviderDomain = host => host === 'api-b2b.backenster.com' || FREE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
const shouldObserveResponseBody = (record, response) => record.providerCandidate
  && !/csrf|token|auth/iu.test(new URL(response.url()).pathname)
  && (/json/iu.test(response.headers()['content-type'] || '')
    || record.httpEvidence?.endpoint === 'google-rpc' && /text\/plain/iu.test(response.headers()['content-type'] || ''));

/** 在读取产物或创建 profile 之前拒绝拼错、缺值和重复的内置库参数。 */
function parseBuiltinGlossaryArg(args) {
  assert(!args.some(value => value.startsWith('--builtin-glossary=')), 'Use --builtin-glossary ai-en-zh-hans');
  const positions = args.flatMap((value, index) => value === '--builtin-glossary' ? [index] : []);
  assert(positions.length <= 1, '--builtin-glossary must occur only once');
  if (!positions.length) return null;
  const value = args[positions[0] + 1];
  assert.equal(value, 'ai-en-zh-hans', '--builtin-glossary only allows ai-en-zh-hans');
  return value;
}

/** 恢复次数在任何浏览器/profile 操作之前校验；默认不手动恢复，只允许原在途请求在原截止内收尾。 */
function parseTranslationResumesArg(args) {
  assert(!args.some(value => value.startsWith('--translation-resumes=')), 'Use --translation-resumes 0..3');
  const positions = args.flatMap((value, index) => value === '--translation-resumes' ? [index] : []);
  assert(positions.length <= 1, '--translation-resumes must occur only once');
  if (!positions.length) return 0;
  const value = args[positions[0] + 1];
  assert(/^[0-3]$/u.test(value || ''), '--translation-resumes must be an integer from 0 to 3');
  return Number(value);
}

/** 仅投影免费测试的公开设置；不读取模型凭据、其它词条或私有用户选项。 */
async function readPublicResumeSettings() {
  const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
  if (!stored?.success) throw new Error('Public resume configuration read failed');
  const config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
  const batch = document.querySelector('.document-batch-translation input');
  if (!config || typeof config !== 'object' || !batch || typeof batch.checked !== 'boolean') throw new Error('Invalid public resume configuration');
  return {name: document.querySelector('.workspace-heading h1')?.textContent.trim() || '',
    from: config.from, to: config.to, service: config.service, documentService: config.documentService,
    freeTranslationOrder: config.freeTranslationOrder, freeTranslationMode: config.freeTranslationMode,
    freeTranslationTimeoutMs: config.freeTranslationTimeoutMs, documentBatchTranslation: batch.checked};
}

/** 自包含页面端口：完整技术原因来自当前恢复提示，旧工具栏提示只作兼容回退。 */
function readProductionTranslationStatus() {
  const text = selector => document.querySelector(selector)?.textContent.trim() || '';
  return {status: text('.document-status'), progress: Number(document.querySelector('.task-progress')?.getAttribute('aria-valuenow') || 0),
    translating: Boolean(document.querySelector('.taskbar-actions .pause-button')),
    error: text('.translation-recovery[role="alert"] .recovery-error-detail') || text('.taskbar-notices .notice.error'),
    retry: text('.translation-recovery[role="status"] .recovery-error-detail') || text('.taskbar-notices .notice.warning')};
}

/** 只识别实际中断的 timeout；暂停、取消、鉴权、配置或回显仍立即失败。 */
function hasTranslationTimeoutFailure(current) {
  return /^翻译中断(?:\s|·|$|已翻译\s*\d+\s*\/\s*\d+(?:\s|·|$))/u.test(current.status) && /(?:翻译)?请求超时$/u.test(current.error)
    && !/401|403|auth|unauthori[sz]ed|forbidden|bad.?config|鉴权|凭据|配置|取消|cancel|原文|回显/iu.test(current.error);
}

/** 已发请求仍在收尾时只观察并保留状态，避免主按钮尚未恢复就提前点击。 */
function isTranslationTimeoutSettling(current) {
  return hasTranslationTimeoutFailure(current) && (current.translating === true || /正在收取已发出的结果/u.test(current.status));
}

/** 恢复必须等待 timeout 收尾结束，不能把仍在提交结果的任务判作 terminal。 */
function isResumableTranslationTimeout(current) {
  return hasTranslationTimeoutFailure(current) && !isTranslationTimeoutSettling(current);
}

/** 逐位置、ID 和原文验证同一解析文档；曾完成的目标必须逐字保留，不用 normalized 文本替代证据。 */
function assertPreservedTranslations(previous, snapshot) {
  assert(snapshot && Array.isArray(snapshot.segments) && snapshot.segments.length, 'Resume requires a saved parsed document');
  const ids = new Set();
  for (const segment of snapshot.segments) {
    assert(Number.isSafeInteger(segment.id) && segment.id >= 0 && !ids.has(segment.id)
      && typeof segment.source === 'string' && typeof segment.translation === 'string', 'Invalid resume source/target snapshot');
    ids.add(segment.id);
  }
  for (const old of previous) {
    for (const key of ['name', 'format', 'parsedVersion', 'pages']) assert.deepEqual(snapshot[key], old[key], `Resume changed document ${key}`);
    assert.equal(snapshot.segments.length, old.segments.length, 'Resume changed segment count');
    old.segments.forEach((segment, index) => {
      const next = snapshot.segments[index];
      assert.equal(next.id, segment.id, 'Resume changed segment index/id');
      assert.equal(next.source, segment.source, 'Resume changed source text');
      if (segment.translation.trim()) assert.equal(next.translation, segment.translation, `Resume changed completed translation ${segment.id}`);
    });
  }
  return snapshot.segments.filter(segment => segment.translation.trim()).length;
}

/** 单文档恢复守卫：真实操作由端口提供，所有端口受原截止约束；离线测试不制造可验收译文。 */
function createTranslationResumeGuard({limit, started, timeout, settings, now = Date.now, sleep = pause}) {
  assert(Number.isInteger(limit) && limit >= 0 && limit <= 3, 'Invalid translation resume limit');
  assert(Number.isFinite(started) && Number.isFinite(timeout) && timeout > 0, 'Invalid translation deadline');
  const deadline = started + timeout, snapshots = [], failures = [], recoveries = [];
  const remaining = () => deadline - now();
  const bounded = async (operation, label, cap = 5000) => {
    assert(remaining() > 0, 'Original translation deadline exhausted');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: original translation deadline or diagnostic bound exhausted`)), Math.min(cap, remaining()));
      })]);
    } finally {clearTimeout(timer);}
  };
  return {failures, recoveries, deadline,
    async tryResume(current, {readSnapshot, readSettings, saveFailure, activateContinue, assertActive, persist}) {
      if (!limit || !isResumableTranslationTimeout(current)) return false;
      assertActive();
      const stop = /第\s*(\d+)\s*段/u.exec(current.error);
      const counts = /(\d+)\s*\/\s*(\d+)/u.exec(current.status);
      const failure = {number: failures.length + 1, status: current.status, error: current.error, progress: current.progress,
        stoppedBatchFirstSegment: stop ? Number(stop[1]) : null, stopNumberMeaning: 'Failed batch first segment; not evidence of the root-cause slot',
        observedCompleted: counts ? Number(counts[1]) : null, observedTotal: counts ? Number(counts[2]) : null,
        elapsedMs: now() - started, remainingMs: Math.max(0, remaining()), resumed: false};
      failures.push(failure); persist();
      let snapshot;
      const snapshotDeadline = Math.min(deadline, now() + 5000);
      while (remaining() > 0) {
        snapshot = await bounded(readSnapshot, 'Failure snapshot read'); assertActive();
        if (Array.isArray(snapshot?.segments) && (failure.observedCompleted === null
          || snapshot.segments.filter(segment => typeof segment.translation === 'string' && segment.translation.trim()).length >= failure.observedCompleted)) break;
        if (now() >= snapshotDeadline) break;
        await sleep(Math.min(100, snapshotDeadline - now(), remaining())); assertActive();
      }
      failure.completed = Array.isArray(snapshot?.segments) ? snapshot.segments.filter(segment => typeof segment.translation === 'string' && segment.translation.trim()).length : 0;
      // 原始失败证据先落盘。验证/点击失败不能抹掉已观察到的产品错误。
      await bounded(() => saveFailure(failure, snapshot), 'Failure evidence save'); assertActive();
      if (recoveries.length >= limit || remaining() <= 0) {failure.resumeRefused = 'Resume limit or original deadline exhausted'; persist(); return false;}
      assert(failure.completed > 0 && (failure.observedCompleted === null || failure.completed >= failure.observedCompleted), 'Saved failure snapshot has not preserved the visible completed count');
      assertPreservedTranslations(snapshots, snapshot);
      assert.equal(snapshot.name, settings.name, 'Resume snapshot belongs to a different input');
      if (failure.observedTotal !== null) assert.equal(snapshot.segments.length, failure.observedTotal, 'Resume changed visible segment count');
      assert.deepEqual(await bounded(readSettings, 'Resume settings read'), settings, 'Resume settings/input/library changed'); assertActive();
      snapshots.push(structuredClone(snapshot));
      const actualButtonName = await bounded(activateContinue, 'Actual continue button activation'); assertActive();
      assert(actualButtonName === undefined || actualButtonName === '重试' || actualButtonName === '继续翻译', 'Unsupported production resume action');
      assert(remaining() > 0, 'Original translation deadline exhausted');
      failure.resumed = true;
      recoveries.push({failureNumber: failure.number, elapsedMs: now() - started, completedBefore: failure.completed,
        actualAction: `Same production document: ${actualButtonName ?? 'resume (legacy port; button name unreported)'}`,
        actualButtonName: actualButtonName ?? null, settingsUnchanged: true, originalDeadline: deadline}); persist();
      return true;
    },
    async verifyFinal(snapshot, readSettings) {
      if (!recoveries.length) return null;
      assertPreservedTranslations(snapshots, snapshot);
      assert.deepEqual(await bounded(readSettings, 'Final resume settings read'), settings, 'Resume settings/input/library changed');
      return {completedTargetsPreserved: true, recoveredAfterFailures: true, resumeCount: recoveries.length,
        initialCompletedCount: snapshots[0].segments.filter(segment => segment.translation.trim()).length,
        originalDeadline: deadline, elapsedMs: now() - started};
    },
  };
}

/** 只激活同工具栏当前可见、可用的生产“重试/继续翻译”主按钮，禁止重新翻译并保留焦点和原截止守卫。 */
async function activateProductionTranslationContinue({page, checkFocus, number, deadline, readStatus}) {
  await checkFocus(`translation-continue-${number}`);
  assert(isResumableTranslationTimeout(await readStatus()), 'Only the same terminal timeout may be continued');
  const button = page.locator('.taskbar-actions').getByRole('button', {name: /^(?:重试|继续翻译)$/u, exact: true})
    .and(page.locator('.translate-document-button'));
  assert.equal(await button.count(), 1, 'Production continue button must be unique');
  assert(await button.isVisible() && await button.isEnabled(), 'Production continue button must be visible and enabled');
  const action = (await button.innerText()).trim();
  assert(action === '重试' || action === '继续翻译', 'Only production retry or continue may be activated');
  assert(deadline > Date.now(), 'Original translation deadline exhausted');
  await button.click({timeout: Math.min(5000, deadline - Date.now())});
  return action;
}

/** 自包含页面端口：只投影运行所需的公开词库元数据，不能输出词条、token 或其余配置。 */
async function readPublicGlossaryState(presetId = null) {
  const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
  if (!stored?.success) throw new Error('Public glossary configuration read failed');
  let config;
  try {config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;} catch {throw new Error('Invalid public glossary configuration');}
  if (!config || typeof config !== 'object' || !Array.isArray(config.glossaryLibraries)) throw new Error('Invalid public glossary libraries');
  const ids = config.documentGlossaryIds == null ? null : config.documentGlossaryIds;
  if (ids !== null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('Invalid public document glossary selection');
  const libraries = config.glossaryLibraries.filter(library => library && typeof library === 'object'
    && (presetId ? library.preset?.id === presetId : ids === null ? library.enabled === true : ids.includes(library.id)));
  return {glossaryEnabled: config.glossaryEnabled === true, documentGlossaryIds: ids === null ? null : [...ids],
    libraries: libraries.map(library => {
      if (typeof library.id !== 'string' || !library.id || typeof library.name !== 'string' || !Array.isArray(library.entries)) throw new Error('Invalid selected glossary metadata');
      const preset = library.preset;
      if (preset && (typeof preset.id !== 'string' || !Number.isSafeInteger(preset.version) || preset.version <= 0)) throw new Error('Invalid selected glossary preset');
      return {id: library.id, name: library.name, enabled: library.enabled === true,
        presetId: preset?.id ?? null, presetVersion: preset?.version ?? null, termCount: library.entries.length};
    })};
}

/** 只选择 production UI 刚导入的库；公开 CAS patch 不包含词表或其它设置。 */
async function selectPublicDocumentGlossary({id, presetId}) {
  if (typeof id !== 'string' || !id || presetId !== 'ai-en-zh-hans') throw new Error('Invalid builtin glossary selection');
  const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
  if (!stored?.success) throw new Error('Public glossary configuration read failed');
  let config;
  try {config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;} catch {throw new Error('Invalid public glossary configuration');}
  if (!Array.isArray(config?.glossaryLibraries)) throw new Error('Invalid public glossary libraries');
  const library = config.glossaryLibraries.find(library => library && library.id === id && library.preset?.id === presetId && library.enabled === true);
  if (!library || config.glossaryEnabled !== true) throw new Error('Imported builtin glossary is not enabled');
  const saved = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch',
    config: {documentGlossaryIds: [id]}, expected: {documentGlossaryIds: config.documentGlossaryIds},
    clientId: 'document-live-glossary-' + crypto.randomUUID(), sequence: 1});
  if (!saved?.success) throw new Error('Public document glossary selection was rejected');
}

/** 使用同一后台页的真实内置库 UI；库由生产包生成，driver 不导入或复制词表。 */
async function installBuiltinGlossaryForLiveRun({page, origin, presetId, checkFocus}) {
  assert.equal(presetId, 'ai-en-zh-hans', 'Unsupported builtin glossary');
  await checkFocus('builtin-glossary-options-open');
  await page.goto(origin + '/options.html#settings-glossary', {waitUntil: 'domcontentloaded'});
  const glossary = page.getByTestId('glossary-settings'); await glossary.waitFor();
  const card = glossary.getByTestId('builtin-' + presetId); await card.waitFor();
  const cardName = (await card.locator('h4').innerText()).trim();
  const before = await page.evaluate(readPublicGlossaryState, presetId);
  assert.equal(before.libraries.length, 0, 'Fresh profile must import a new editable builtin copy');
  await checkFocus('builtin-glossary-import'); await card.locator('button.builtin-add').click();
  await card.locator('.builtin-added').waitFor();
  const imported = await page.evaluate(readPublicGlossaryState, presetId);
  assert.equal(imported.libraries.length, 1, 'Builtin UI did not persist one library');
  const library = imported.libraries[0];
  assert.equal(library.name, cardName); assert(library.enabled && library.termCount > 0);
  const master = glossary.locator('.feature-enable-card [role="switch"]');
  if (await master.getAttribute('aria-checked') !== 'true') {
    await checkFocus('builtin-glossary-enable'); await master.focus(); await page.keyboard.press('Space');
  }
  await page.waitForFunction(async () => {
    const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!stored?.success) return false;
    const config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
    return config?.glossaryEnabled === true;
  }, null, {timeout: 15000});
  await checkFocus('builtin-glossary-document-selection');
  await page.evaluate(selectPublicDocumentGlossary, {id: library.id, presetId});
  const selected = await page.evaluate(readPublicGlossaryState, presetId);
  assert.equal(selected.glossaryEnabled, true); assert.deepEqual(selected.documentGlossaryIds, [library.id]);
  assert.deepEqual(selected.libraries, imported.libraries);
  return {presetId, source: 'Production options builtin UI creates its editable copy; public persistConfig selects only that actual library id',
    before, imported, selected, optionsUrl: origin + '/options.html#settings-glossary'};
}

function directoryFingerprint(directory) {
  const entries = [];
  const walk = (root, relative = '') => {
    for (const entry of fs.readdirSync(root, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name), absolute = path.join(root, entry.name);
      if (entry.isDirectory()) walk(absolute, name);
      else if (entry.isFile()) entries.push({name, bytes: fs.statSync(absolute).size, sha256: sha(fs.readFileSync(absolute))});
    }
  };
  walk(directory); return {sha256: sha(JSON.stringify(entries)), files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0)};
}

function requestSourceHashes(request) {
  const url = new URL(request.url()), raw = request.postData(), sources = [];
  for (const name of ['q', 'query', 'text']) {const value = url.searchParams.get(name); if (value) sources.push(value);}
  if (raw) {
    try {
      const body = JSON.parse(raw);
      if (Array.isArray(body)) sources.push(...body.filter(value => typeof value === 'string'));
      else {
        for (const name of ['q', 'query', 'text']) if (typeof body[name] === 'string') sources.push(body[name]);
        for (const values of [body.source?.text_list, body.texts, body.contents]) if (Array.isArray(values)) sources.push(...values.filter(value => typeof value === 'string'));
      }
    } catch {
      if (raw.includes('Content-Disposition: form-data;')) {
        const value = /name="query"\r\n\r\n([\s\S]*?)\r\n--/u.exec(raw)?.[1]; if (value) sources.push(value);
      } else {
        const params = new URLSearchParams(raw); for (const name of ['q', 'query', 'text']) {const value = params.get(name); if (value) sources.push(value);}
      }
    }
  }
  return sources.map(value => ({sha256: sha(value), chars: value.length}));
}

function responseTranslationEvidence(value) {
  const texts = [];
  const collect = candidate => {if (typeof candidate === 'string') texts.push(candidate);};
  const entry = item => {
    if (typeof item === 'string') collect(item);
    else if (Array.isArray(item)) collect(item[0]);
    else if (item && typeof item === 'object') {
      collect(item.data?.translateText); collect(item.data?.translation); collect(item.data?.translate?.dit);
      collect(item.fanyi?.tran); collect(item.result); collect(item.responseData?.translatedText); collect(item.translation);
      for (const translated of Array.isArray(item.translation) ? item.translation : []) collect(translated);
      for (const translated of Array.isArray(item.translations) ? item.translations : []) collect(translated?.text ?? translated);
      for (const translated of Array.isArray(item.auto_translation) ? item.auto_translation : []) collect(translated);
      for (const translated of Array.isArray(item.content?.translations) ? item.content.translations : []) collect(translated?.translation);
      for (const choice of Array.isArray(item.choices) ? item.choices : []) collect(choice.message?.content);
    }
  };
  if (Array.isArray(value)) value.forEach(entry); else entry(value);
  return [...new Set(texts)].map(text => ({sha256: sha(text), chars: text.length, tail: text.slice(-64)}));
}

/** 只收集已完成的翻译响应证据；读取截止后，原始 promise 的晚结果不得回填旧记录或下一份文档。 */
function createResponseBodyObserver({timeoutMs = 5000} = {}) {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Response observation requires a finite deadline');
  const pending = new Map();
  const stats = {timeoutMs, started: 0, completed: 0, timedOut: 0, failed: 0, active: 0, drainTimeouts: 0};
  const observe = (response, record) => {
    const observation = {state: 'pending', startedAt: Date.now(), timeoutMs}; record.bodyObservation = observation;
    stats.started++; stats.active++;
    let timer, settled = false, resolve;
    const completion = new Promise(done => {resolve = done;});
    const finish = (state, value, reason) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try {
        if (state === 'completed') {
          let evidence;
          if (record.httpEvidence?.endpoint) {
            const decoded = decodeHttpTranslationResponse(record.httpEvidence, value);
            record.httpEvidence.response = {complete: decoded.complete, classification: decoded.classification,
              slotCount: decoded.slots.length, reason: decoded.reason};
            evidence = decoded.slots.map(slot => ({slot: slot.id, sha256: sha(slot.text), chars: slot.text.length, tail: slot.text.slice(-64)}));
          } else evidence = responseTranslationEvidence(value);
          if (evidence.length) record.translations = evidence;
          if (Array.isArray(value?.choices)) record.finishReasons = value.choices.map(choice => choice.finish_reason);
        }
      } catch (error) {state = 'failed'; value = error;}
      observation.state = state; observation.elapsedMs = Date.now() - observation.startedAt;
      if (state === 'timedOut') observation.reason = reason;
      if (state === 'failed') observation.errorName = value?.name || 'ResponseBodyReadError';
      stats[state]++; stats.active--; pending.delete(completion); resolve();
    };
    pending.set(completion, () => finish('timedOut', undefined, 'drain-deadline'));
    timer = setTimeout(() => finish('timedOut', undefined, 'body-deadline'), timeoutMs);
    Promise.resolve().then(() => record.httpEvidence?.endpoint === 'google-rpc' ? response.text() : response.json())
      .then(value => finish('completed', value), error => finish('failed', error));
    return completion;
  };
  const drain = async ({timeoutMs: drainTimeoutMs = timeoutMs + 250} = {}) => {
    assert(Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0, 'Response drain requires a finite deadline');
    const entries = [...pending.entries()]; if (!entries.length) return;
    const timer = setTimeout(() => {
      const active = entries.filter(([promise]) => pending.has(promise));
      if (active.length) {stats.drainTimeouts++; for (const [, finish] of active) finish();}
    }, drainTimeoutMs);
    try {await Promise.allSettled(entries.map(([promise]) => promise));} finally {clearTimeout(timer);}
  };
  return {observe, drain, stats};
}

/** 已确认自有实例仍通过原 guarded close 关闭；诊断 promise 与关闭失败不能跳过原生观察器收尾。 */
async function closeLiveSession({launched, focusMonitor, profileDir, launchAttempted, report, responseObserver}) {
  let closed = false;
  if (launched) {try {await launched.close(); closed = true;} catch (error) {report.cleanupErrors.push(String(error));}}
  try {
    if (closed) fs.rmSync(profileDir, {recursive: true, force: true}); else if (!launchAttempted) fs.rmdirSync(profileDir); else report.retainedProfile = profileDir;
  } catch (error) {report.retainedProfile = profileDir; report.cleanupErrors.push(String(error));}
  try {await responseObserver?.drain({timeoutMs: 1000});} catch (error) {report.cleanupErrors.push(String(error));}
  if (focusMonitor) {try {await focusMonitor.stop();} catch (error) {report.cleanupErrors.push(String(error));}}
}

async function inspectPdf(bytes, requireRepo) {
  const {getDocument} = await import(requireRepo.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
    standardFontDataUrl: path.join(path.dirname(requireRepo.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const pdf = await task.promise, pages = [], labels = await pdf.getPageLabels();
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const viewport = page.getViewport({scale: 1});
        pages.push({number, label: labels?.[number - 1], width: viewport.width, height: viewport.height,
          text: (await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join('\n')});
      } finally {page.cleanup();}
    }
    return pages;
  } finally {await task.destroy();}
}

function validatePdf(source, output) {
  const mapped = mapPdfLayoutPages(source.length, output);
  const sourceTexts = source.map(page => compact(page.text));
  const evidence = source.map((page, index) => {
    const text = sourceTexts[index], anchors = [];
    for (const fraction of [0, .2, .5, .75]) {
      const start = Math.max(0, Math.min(Math.floor(text.length * fraction), text.length - 60)), anchor = text.slice(start, start + 60);
      if (anchor.length >= 24 && !sourceTexts.some((other, otherIndex) => otherIndex !== index && other.includes(anchor)) && !anchors.includes(anchor)) anchors.push(anchor);
    }
    const actual = mapped.pages[index], width = page.width * 2 + Math.max(8, Math.min(24, page.width * .025));
    return {page: index + 1, anchors: anchors.length, sourceOrderOk: !anchors.length || Boolean(actual && anchors.every(anchor => compact(actual.text).includes(anchor))),
      dimensionsOk: Boolean(actual && Math.abs(actual.width - width) < .02 && Math.abs(actual.height - page.height) < .02),
      expectedWidth: width, actualWidth: actual?.width, expectedHeight: page.height, actualHeight: actual?.height};
  });
  return {ok: mapped.ok && evidence.every(page => page.sourceOrderOk && page.dimensionsOk),
    layoutPageMapping: {ok: mapped.ok, labelled: mapped.labelled, indices: mapped.indices, continuations: mapped.continuations}, sourcePages: source.length, outputPages: output.length, pages: evidence};
}

/** 只验证本次实际中文译段可从 PDF 文字层完整按顺序提取，不据此评价译意或图中公式。 */
function validateReadableCopyText(snapshot, pages) {
  const content = pages.map(page => compact(page.text)).join(''), matches = [];
  let offset = 0;
  for (const segment of snapshot.segments) {
    if (!/\p{Script=Han}/u.test(segment.translation) || compact(segment.source) === compact(segment.translation)) continue;
    const target = compact(segment.translation), at = content.indexOf(target, offset);
    matches.push({segment: segment.id, chars: segment.translation.length, translationSha256: sha(segment.translation), found: at >= 0, offset: at});
    if (at >= 0) offset = at + target.length;
  }
  return {ok: pages.length > 0 && matches.length > 0 && matches.every(match => match.found), outputPages: pages.length,
    expectedChineseSegments: matches.length, copiedChineseSegments: matches.filter(match => match.found).length, matches,
    boundary: 'Exact saved target text, ignoring whitespace/NFKC presentation, in source segment order; formula/figure pixels and general semantic quality are not checked.'};
}

/** 独立重开实际下载，不调用产品导出函数计算“预期输出”。 */
async function validateOtherDownload(sourceBytes, outputBytes, snapshot, requireRepo) {
  const format = snapshot.format, {parseHTML} = requireRepo('linkedom'), {SaxesParser} = requireRepo('saxes');
  const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const canonicalSlots = text => text.replace(/(?:&lt;|[＜〈（(])\s*([\/／]?)\s*g\s*(\d+)\s*([\/／]?)\s*(?:&gt;|[＞〉）)])/giu,
    (_match, open, id, close) => `<${open ? '/' : ''}g${id}${close ? '/' : ''}>`);
  // 保留真实标签字符，只解码一层实体，兼容服务返回的转义标签与文字实体；不执行 HTML。
  const canonicalEntities = text => parseHTML(`<html><body>${text.replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</body></html>`).document.body.textContent;
  const withoutSlots = text => text.replace(/<\/?g\d+\s*\/?>/gu, '');
  const markdownText = text => text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/(?:^|\n)\s*(?:#{1,6}\s+|>\s*)/gu, '\n').replace(/[*_`]/gu, '');
  const visible = (text, decoded = false) => {
    // 字幕导出会把服务返回的转义样式还原为真实标签；只归一允许的样式，不把普通正文实体当成 markup。
    const styled = format === 'srt' ? text.replace(/&lt;(\/?(?:i|b|u|em|strong|font|span)\b[^&]*?)&gt;/giu, '<$1>') : text;
    return compact(markdownText(withoutSlots(canonicalSlots(decoded ? styled : canonicalEntities(styled))).replace(/<\/?(?:i|b|u|em|strong|font|span)\b[^>]*>/gu, '')));
  };
  const xmlText = xml => {
    let text = ''; const parser = new SaxesParser({xmlns: true});
    parser.on('text', value => {text += value;}); parser.on('cdata', value => {text += value;});
    parser.write(xml).close(); return text;
  };
  const checks = {format, validStructure: false, translationSegments: 0};
  let text;
  if (format === 'docx' || format === 'epub') {
    const JSZip = requireRepo('jszip'), original = await JSZip.loadAsync(sourceBytes), output = await JSZip.loadAsync(outputBytes);
    const sourceNames = Object.keys(original.files).filter(name => !original.files[name].dir), names = Object.keys(output.files).filter(name => !output.files[name].dir);
    assert(sourceNames.every(name => names.includes(name)), 'Archive lost a source resource');
    const textNames = names.filter(name => format === 'docx' ? /^word\/(?:document|header\d*|footer\d*)\.xml$/u.test(name) : /\.(?:xhtml|html|htm)$/iu.test(name));
    assert(textNames.length, 'Exported archive must contain readable content');
    text = (await Promise.all(textNames.map(async name => xmlText(await output.file(name).async('string'))))).join('\n');
    for (const name of names.filter(name => /\.(?:xml|rels|opf|ncx)$/iu.test(name))) xmlText(await output.file(name).async('string'));
    const images = sourceNames.filter(name => /\.(?:png|jpe?g|gif|webp|svg|bmp|emf|wmf)$/iu.test(name));
    checks.images = [];
    for (const name of images) {
      const before = await original.file(name).async('uint8array'), after = await output.file(name).async('uint8array');
      assert.equal(sha(after), sha(before), `Archive image changed: ${name}`);
      checks.images.push({name, bytes: after.length, sha256: sha(after)});
    }
    checks.sourceResources = sourceNames.length; checks.outputResources = names.length; checks.contentParts = textNames;
    if (format === 'docx') {
      for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) assert(output.file(name), `DOCX missing ${name}`);
    } else {
      assert.equal(await output.file('mimetype')?.async('string'), 'application/epub+zip');
      assert(output.file('META-INF/container.xml'), 'ePub container missing');
      assert.equal(outputBytes.readUInt32LE(0), 0x04034b50);
      assert.equal(outputBytes.readUInt16LE(8), 0, 'ePub mimetype must remain uncompressed');
      assert.equal(outputBytes.subarray(30, 30 + outputBytes.readUInt16LE(26)).toString(), 'mimetype', 'ePub mimetype must be the first ZIP entry');
    }
  } else {
    text = decode(outputBytes); const source = decode(sourceBytes);
    if (format === 'json') {
      const original = JSON.parse(source), output = JSON.parse(text); let strings = 0;
      const verify = (before, after) => {
        if (typeof before === 'string') {assert.equal(typeof after, 'string'); assert(compact(after).includes(compact(before)), 'JSON bilingual leaf lost its source'); strings++;}
        else if (before && typeof before === 'object') {
          assert(after && typeof after === 'object'); assert.equal(Array.isArray(after), Array.isArray(before));
          assert.deepEqual(Object.keys(after), Object.keys(before)); for (const key of Object.keys(before)) verify(before[key], after[key]);
        } else assert.equal(after, before, 'JSON non-text value changed');
      };
      verify(original, output); checks.stringLeaves = strings;
    } else if (format === 'srt') {
      const cues = value => value.trim().split(/\r?\n\s*\r?\n/u).map(cue => {
        const lines = cue.split(/\r?\n/u); assert(/^\d+$/u.test(lines[0])); assert(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}$/u.test(lines[1]));
        return {index: lines[0], timing: lines[1], text: lines.slice(2).join('\n')};
      });
      const original = cues(source), output = cues(text); assert.equal(output.length, original.length);
      original.forEach((cue, index) => {assert.equal(output[index].index, cue.index); assert.equal(output[index].timing, cue.timing); assert(visible(output[index].text).includes(visible(cue.text)));});
      checks.cues = output.length; checks.timingsPreserved = true;
    } else if (format === 'html') {
      const original = parseHTML(source).document, output = parseHTML(text).document;
      assert(output.querySelector('[data-fluent-read-document-translation]'), 'HTML should contain actual bilingual translation markup');
      const refs = document => [...document.querySelectorAll('a[href],img[src]')].map(node => node.getAttribute(node.tagName === 'A' ? 'href' : 'src'));
      const outputRefs = refs(output); assert(refs(original).every(value => outputRefs.includes(value)), 'HTML links/images changed');
      [...original.querySelectorAll('pre,code')].forEach(node => {assert(output.body.textContent.includes(node.textContent), 'HTML code changed');});
      text = output.body.textContent; checks.linksAndImagesPreserved = true;
    } else if (format === 'markdown') {
      const lineCounts = value => value.split(/\r?\n/u).filter(line => line.trim()).reduce((counts, line) => counts.set(line, (counts.get(line) || 0) + 1), new Map());
      const sourceLines = lineCounts(source), outputLines = lineCounts(text);
      sourceLines.forEach((count, line) => assert((outputLines.get(line) || 0) >= count, `Markdown bilingual output changed a source line: ${line.slice(0, 80)}`));
      let translatedBlockPrefixes = 0;
      const lines = text.split(/\r?\n/u);
      source.split(/\r?\n/u).forEach(line => {
        const prefix = /^(\s*(?:#{1,6}|[-+*]|\d+[.)])\s+)/u.exec(line)?.[1];
        if (!prefix) return;
        const at = lines.indexOf(line), translatedLine = lines[at + 1];
        if (!translatedLine?.startsWith('> ')) return;
        assert(translatedLine.slice(2).startsWith(prefix), `Markdown translated heading/list prefix changed: ${line.slice(0, 80)}`);
        translatedBlockPrefixes++;
      });
      const code = source.match(/^\s*```[^\n]*\n[\s\S]*?^\s*```/gmu) || [];
      code.forEach(value => assert(text.includes(value), 'Markdown fenced code changed'));
      const inlineCode = [...source.matchAll(/(?<!`)(`+)(?!`)([^\n]*?)\1(?!`)/gu)].map(match => match[0]);
      inlineCode.forEach(value => assert(text.includes(value), 'Markdown inline code changed'));
      const refs = [...source.matchAll(/\]\(([^)]*)\)/gu)].map(match => match[1]); refs.forEach(value => assert(text.includes(`](${value})`), 'Markdown destination changed'));
      const sourceEmphasis = [...source.matchAll(/(?<![\\*])(\*\*|\*)(?![\s*])([^*\n]*?\S)\1(?!\*)|(?<![\\\p{L}\p{N}])(__|_)(?![\s_])([^_\n]*?\S)\3(?![\p{L}\p{N}_])/gu)].map(match => match[0]);
      sourceEmphasis.forEach(value => assert(text.includes(value), 'Markdown source emphasis changed'));
      // 使用仓库已有的标准 markdown-it，不执行 HTML/Vue 或代码高亮。按实际节点及正文计数，
      // 从双语输出扣除原文的同类型/同正文节点后，剩余节点才可证明真实译文的强调有效。
      const {createMarkdownRenderer} = await import(requireRepo.resolve('vitepress'));
      const markdown = await createMarkdownRenderer(process.cwd(), {highlight: value => value, linkify: false});
      const inlineText = tokens => tokens.filter(token => ['text', 'code_inline', 'softbreak', 'hardbreak'].includes(token.type))
        .map(token => ['softbreak', 'hardbreak'].includes(token.type) ? '\n' : token.content).join('');
      const plainInline = value => markdown.parseInline(value, {}).map(token => inlineText(token.children || [])).join('');
      const styles = value => markdown.parse(value, {}).flatMap(token => {
        const nodes = [], active = [];
        for (const child of token.children || []) {
          if (['strong_open', 'em_open'].includes(child.type)) active.push({type: child.type.slice(0, -5), text: ''});
          else if (['strong_close', 'em_close'].includes(child.type)) nodes.push(active.pop());
          else for (const node of active) node.text += inlineText([child]);
        }
        return nodes;
      });
      const styleKey = (type, value) => `${type}:${compact(value)}`;
      const counts = nodes => nodes.reduce((values, node) => {
        const key = styleKey(node.type, node.text); values.set(key, (values.get(key) || 0) + 1); return values;
      }, new Map());
      const sourceStyles = styles(source), outputStyles = styles(text), eligibleStyles = counts(sourceStyles), translatedStyles = counts(outputStyles);
      for (const [key, count] of eligibleStyles) {
        const actual = translatedStyles.get(key) || 0;
        assert(actual >= count, `Standard Markdown lost an original emphasis node: ${key}`);
        translatedStyles.set(key, actual - count);
      }
      const standardStyleChecks = [];
      let translatedEmphasis = 0, translatedHtmlTokens = 0;
      const translatedContent = compact(canonicalEntities(text)), inlineTextRegressions = [];
      for (const part of snapshot.markdownParts || []) {
        const segment = snapshot.segments.find(segment => segment.id === part.segmentIndex);
        assert(segment, `Markdown metadata has no source segment ${part.segmentIndex}`);
        for (const [index, token] of part.tokens.entries()) {
          const emphasis = ['*', '**', '_', '__'].includes(token.open) && token.close === token.open;
          const html = /^<[A-Za-z][^<>]*>$/u.test(token.open) && /^<\/[A-Za-z][^<>]*>$/u.test(token.close || '');
          if (!emphasis && !html) continue;
          const id = index + 1, marker = new RegExp(`<\\s*g\\s*${id}\\s*>([\\s\\S]*?)<\\s*\\/\\s*g\\s*${id}\\s*>`, 'iu');
          const translated = marker.exec(canonicalSlots(canonicalEntities(segment.translation)));
          assert(translated, `Live service dropped Markdown ${emphasis ? 'emphasis' : 'HTML'} in segment ${part.segmentIndex}, marker ${id}`);
          assert(translatedContent.includes(compact(`${token.open}${translated[1]}${token.close}`)), `Markdown export lost translated ${emphasis ? 'emphasis' : 'HTML'} in segment ${part.segmentIndex}, marker ${id}`);
          // 只机械检查这次真实发现的两项回归，不能证明一般语义质量。按源词和同一标签匹配，
          // 不依赖章节/段落 id；代码自闭合槽位、产品标识和 Reference 等名称允许保留英文。
          const original = emphasis ? marker.exec(canonicalSlots(canonicalEntities(segment.source))) : null;
          if (original) {
            const type = token.open.length === 2 ? 'strong' : 'em', originalKey = styleKey(type, plainInline(original[1]));
            // 只要求原文中已被标准解析器识别的样式；不把原有无效 Markdown 升级为新语法。
            if ((eligibleStyles.get(originalKey) || 0) > 0) {
              eligibleStyles.set(originalKey, eligibleStyles.get(originalKey) - 1);
              const body = plainInline(translated[1]), translatedKey = styleKey(type, body), count = translatedStyles.get(translatedKey) || 0;
              assert(count > 0, `Standard Markdown lost translated ${type} in segment ${part.segmentIndex}, marker ${id}: ${body}`);
              translatedStyles.set(translatedKey, count - 1);
              standardStyleChecks.push({segment: part.segmentIndex, marker: id, type, body, chineseBody: /\p{Script=Han}/u.test(body)});
            }
          }
          if (original && ['bold', 'documenttranslation'].includes(compact(original[1]))) {
            assert(compact(translated[1]) !== compact(original[1]) && /\p{Script=Han}/u.test(translated[1]),
              `Live service left ordinary Markdown emphasis untranslated in segment ${part.segmentIndex}, marker ${id}: ${original[1]}`);
            inlineTextRegressions.push({segment: part.segmentIndex, marker: id, source: original[1], target: translated[1]});
          }
          if (emphasis) translatedEmphasis++; else translatedHtmlTokens++;
        }
      }
      // 原文仍在双语文件中，不能用它证明译后的 HTML 容器有效；逐段核对真实返回的标签。
      let rawHtmlSegments = 0;
      for (const segment of snapshot.segments) {
        const tags = segment.source.match(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/gu)?.filter(tag => !/^<\/?g\d+\s*\/?>$/iu.test(tag)) || [];
        if (!tags.length) continue;
        tags.forEach(tag => assert(segment.translation.includes(tag), `Live service changed Markdown HTML tag in segment ${segment.id}: ${tag}`));
        if (tags.length === 1 && segment.source.trim() === tags[0]) assert.equal(segment.translation.trim(), tags[0], `Live service changed a standalone Markdown HTML tag in segment ${segment.id}`);
        rawHtmlSegments++;
      }
      const components = source.match(/<GuideVisual\b[^>]*\/\s*>/gu) || [];
      components.forEach(value => assert(text.includes(value), 'Markdown guide component changed'));
      const directives = value => value.split(/\r?\n/u).filter(line => /^\s*(?:>\s*)*:::/u.test(line));
      assert.deepEqual(directives(text), directives(source), 'Markdown directive syntax was changed or duplicated');
      const structure = source.match(/<\/?(?:details|summary)\b[^>]*>/gu) || [];
      structure.forEach(value => assert(text.includes(value), 'Markdown HTML container changed'));
      checks.fencedCodeBlocks = code.length; checks.inlineCodeSpans = inlineCode.length; checks.linkDestinations = refs.length;
      checks.sourceEmphasis = sourceEmphasis.length; checks.translatedEmphasis = translatedEmphasis;
      checks.standardMarkdown = {
        parser: 'VitePress bundled markdown-it; standard emphasis delimiter rules; parsed text only',
        sourceStrong: sourceStyles.filter(node => node.type === 'strong').length, sourceEm: sourceStyles.filter(node => node.type === 'em').length,
        outputStrong: outputStyles.filter(node => node.type === 'strong').length, outputEm: outputStyles.filter(node => node.type === 'em').length,
        translatedStrong: standardStyleChecks.filter(node => node.type === 'strong').length, translatedEm: standardStyleChecks.filter(node => node.type === 'em').length,
        nodes: standardStyleChecks,
        boundary: 'Mechanical formatting regression check against actual saved target bodies; valid style and Chinese text do not establish general semantic quality.',
      };
      checks.inlineTextRegressions = inlineTextRegressions;
      checks.translatedHtmlTokens = translatedHtmlTokens; checks.rawHtmlSegments = rawHtmlSegments;
      checks.translatedBlockPrefixes = translatedBlockPrefixes;
      checks.originalLinesPreserved = true; checks.guideComponents = components.length; checks.directives = directives(source); checks.htmlContainerTags = structure.length;
      text = markdownText(text);
    } else assert.equal(format, 'txt', 'Unsupported download validation format');
  }
  const content = visible(text);
  for (const segment of snapshot.segments) {
    // 单个 g 标记在导出中会还原成代码/网址；按这些插入位置核对译文连续片段，不能要求插入前后相邻。
    const pieces = canonicalSlots(canonicalEntities(segment.translation)).split(/<\s*g\s*\d+\s*\/\s*>/iu).map(piece => visible(piece, true)).filter(Boolean);
    assert(pieces.length, `Actual download has no translated text for segment ${segment.id}`);
    let offset = 0;
    for (const piece of pieces) {
      const found = content.indexOf(piece, offset);
      assert(found >= 0, `Actual download lost translation segment ${segment.id}`);
      offset = found + piece.length;
    }
    checks.translationSegments++;
  }
  assert.equal(checks.translationSegments, snapshot.segments.length); checks.validStructure = true; checks.ok = true;
  return checks;
}

async function historySnapshot(page, name) {
  return page.evaluate(async name => {
    const database = await new Promise((resolve, reject) => {const request = indexedDB.open('FluentReadDocumentHistory', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
    try {
      const records = await new Promise((resolve, reject) => {const request = database.transaction('documents', 'readonly').objectStore('documents').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
      const record = records.filter(value => value.name === name).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!record?.parsed?.segments) return null;
      const parsed = record.parsed;
      return {name: record.name, format: parsed.format, parsedVersion: record.parsedVersion, updatedAt: record.updatedAt,
        segments: parsed.segments.map((segment, index) => ({...segment, translation: record.translations[segment.id ?? index] ?? ''})),
        ...(parsed.format === 'markdown' ? {markdownParts: parsed.parts.filter(part => part.kind === 'segment' && part.markdownTokens).map(part => ({segmentIndex: part.segmentIndex, tokens: part.markdownTokens}))} : {}),
        pages: parsed.binary?.kind === 'pdf' ? parsed.binary.pages.map(({pageNumber, width, height, rotation, sourceRotation, segmentIndexes}) => ({pageNumber, width, height, rotation, sourceRotation, segmentIndexes})) : undefined};
    } finally {database.close();}
  }, name);
}

/** 下载事件与可见产品错误同时观察；明确报错不能被当成仍在生成文件的性能等待。 */
async function waitForDocumentDownload(page, dialog, {timeout, click, assertActive, onProductError}) {
  let download, clickFailure;
  const onDownload = value => {download = value;};
  page.on('download', onDownload);
  const deadline = Date.now() + timeout;
  try {
    assertActive();
    // 先注册事件再触发下载。点击失败始终被接收，即使页面报错或焦点守卫先结束等待。
    void Promise.resolve().then(click).catch(error => {clickFailure = error;});
    while (true) {
      assertActive();
      const errorText = await dialog.locator('.notice.error,[role="alert"]').evaluateAll(elements => elements
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
        .map(element => element.textContent.trim()).filter(Boolean).join('\n'));
      assertActive();
      if (errorText) {
        await onProductError(errorText);
        assertActive();
        throw new Error(`Document export reported a product error: ${errorText}`);
      }
      if (download) return download;
      if (clickFailure) throw clickFailure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Document export produced neither a download nor a visible product error within ${timeout}ms`);
      await pause(Math.min(100, remaining));
    }
  } finally {
    page.off('download', onDownload);
  }
}

const waitPdfFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function assertBrowserScale(page) {
  const result = await page.evaluate(async () => {const tab = await chrome.tabs.getCurrent(); return {tabZoom: await chrome.tabs.getZoom(tab.id), visualViewportScale: window.visualViewport?.scale ?? 1};});
  assert.equal(result.tabZoom, 1, 'Document interactions must retain browser tab zoom 100%');
  assert.equal(result.visualViewportScale, 1, 'Document interactions must retain the outer viewport scale');
  return result;
}

/** 焦点只移到网页控件；选项完全通过 CDP 键盘遍历和原生按钮激活，不派发合成 DOM 事件。 */
async function choosePdfOptionByKeyboard(page, selector, value, activation, checkFocus) {
  await checkFocus(`pdf-ui-menu-${value}-${activation.toLowerCase()}`);
  const control = page.locator(selector), trigger = control.locator('.pdf-menu-button');
  await trigger.focus(); await page.keyboard.press('Enter');
  const options = control.locator('.pdf-menu-list [role="option"]'); await options.first().waitFor();
  const choices = await options.evaluateAll(elements => elements.map(element => ({value: element.dataset.value, label: element.textContent.trim(), tagName: element.tagName, type: element.getAttribute('type')})));
  assert(choices.length && choices.every(option => option.tagName === 'BUTTON' && option.type === 'button'), 'PDF options must be native buttons reachable by keyboard');
  assert(choices.some(option => option.value === value), `Missing PDF option ${value}`);
  let active;
  for (let tabs = 0; tabs <= choices.length + 2; tabs++) {
    active = await page.evaluate(selector => {const node = document.activeElement; return {inMenu: Boolean(node?.closest(selector)?.querySelector('.pdf-menu-list')?.contains(node)), value: node?.getAttribute('data-value'), role: node?.getAttribute('role'), tagName: node?.tagName, label: node?.textContent.trim()};}, selector);
    if (active.inMenu && active.value === value && active.role === 'option') break;
    await page.keyboard.press('Tab');
  }
  assert(active?.inMenu && active.value === value && active.tagName === 'BUTTON', `Tab cannot reach PDF option ${value}: ${JSON.stringify(active)}`);
  await page.keyboard.press(activation);
  await control.locator('.pdf-menu-list').waitFor({state: 'hidden'});
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'Selecting a PDF option must restore trigger focus');
  return {selector, value, label: active.label, activation, input: 'CDP keyboard: Enter opens, Tab traverses, native button activates', options: choices};
}

const pdfZoomMetrics = page => page.locator('[data-pdf-scroll]').evaluate(element => ({scale: Number(element.dataset.readerZoom), scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight}));
const pdfPointerAnchor = (page, point) => page.evaluate(point => {
  const viewport = document.querySelector('[data-pdf-scroll]'), frame = viewport.querySelector('.pdf-page-column:not(.translated) .pdf-page-frame');
  const rect = frame.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
  const anchor = point || {clientX: (Math.max(rect.left, bounds.left + 8) + Math.min(rect.right, bounds.right - 8)) / 2,
    clientY: (Math.max(rect.top, bounds.top + 8) + Math.min(rect.bottom, bounds.bottom - 8)) / 2};
  return {point: anchor, page: frame.closest('[data-page-number]').dataset.pageNumber, x: (anchor.clientX - rect.left) / rect.width, y: (anchor.clientY - rect.top) / rect.height, width: rect.width, height: rect.height};
}, point);

/** 首份实际文件的源文视口：复用旧缩放验收的受控事件机制，不引入其网络 fixture。 */
async function exercisePdfZoomUi(page, {result, prefix, shot, checkFocus, persist}) {
  const evidence = result.pdfUi = {scope: 'First actual PDF only; source viewport before live translation, then translated presentation menus',
    inputMode: 'CDP keyboard and Ctrl/Cmd wheel; no synthetic WheelEvent and no physical trackpad validation', menus: [], wheel: []};
  evidence.menus.push(await choosePdfOptionByKeyboard(page, '.pdf-zoom-control', '1', 'Enter', checkFocus)); persist();
  await page.waitForFunction(() => Number(document.querySelector('[data-pdf-scroll]').dataset.readerZoom) === 1);
  await page.waitForFunction(() => {const canvas = document.querySelector('.pdf-page-column:not(.translated) canvas'); return canvas && Math.abs(canvas.getBoundingClientRect().width - canvas.width / devicePixelRatio) < 2;});
  await page.locator('[data-pdf-scroll]').evaluate(element => {element.scrollTop = 120; element.scrollLeft = 40;}); await waitPdfFrames(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const [name, modifiers] of [['Ctrl', 2], ['Cmd', 4]]) {
      await checkFocus(`pdf-ui-${name.toLowerCase()}-wheel`);
      const before = await pdfZoomMetrics(page), anchorBefore = await pdfPointerAnchor(page), point = {x: anchorBefore.point.clientX, y: anchorBefore.point.clientY};
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', ...point, deltaX: 0, deltaY: -70, modifiers});
      await page.waitForFunction(before => Number(document.querySelector('[data-pdf-scroll]').dataset.readerZoom) > before, before.scale); await waitPdfFrames(page);
      const after = await pdfZoomMetrics(page), anchorAfter = await pdfPointerAnchor(page, anchorBefore.point);
      const drift = {x: Math.abs(anchorAfter.x - anchorBefore.x) * anchorAfter.width, y: Math.abs(anchorAfter.y - anchorBefore.y) * anchorAfter.height};
      evidence.wheel.push({modifier: name, deltaY: -70, before, after, anchorBefore, anchorAfter, drift, browserScale: await assertBrowserScale(page)}); persist();
      assert.equal(anchorAfter.page, anchorBefore.page, 'Zoom must retain the visible source page');
      assert(drift.x < 3 && drift.y < 3, `Actual PDF pointer anchor drifted: ${JSON.stringify(drift)}`);
    }
    await checkFocus('pdf-ui-keyboard-zoom');
    await page.locator('[data-pdf-scroll]').focus();
    const before = await pdfZoomMetrics(page); await page.keyboard.press('Control+='); await waitPdfFrames(page);
    const plus = await pdfZoomMetrics(page); assert(plus.scale > before.scale, 'Ctrl plus must enlarge the document');
    await page.keyboard.press('Meta+-'); await waitPdfFrames(page);
    const minus = await pdfZoomMetrics(page); assert(minus.scale < plus.scale, 'Cmd minus must reduce the document');
    await page.keyboard.press('Control+0'); await waitPdfFrames(page);
    const reset = await pdfZoomMetrics(page), resetLabel = await page.locator('.pdf-zoom-control .pdf-menu-button').innerText();
    assert.match(resetLabel, /适合宽度|Fit width/u);
    evidence.keyboard = {before, plus, minus, reset, resetLabel, browserScale: await assertBrowserScale(page)};
    const screenshot = await shot(`${prefix}-pdf-ui-source-keyboard-and-wheel`); result.screenshots.push(screenshot); evidence.sourceScreenshot = screenshot; persist();
    evidence.menus.push(await choosePdfOptionByKeyboard(page, '.pdf-zoom-control', 'page', 'Space', checkFocus));
    await page.locator('[data-pdf-scroll]').evaluate(element => {element.scrollTop = 0; element.scrollLeft = 0;});
    evidence.preTranslationRestore = {presentation: await page.locator('.pdf-layout-viewer').getAttribute('data-pdf-presentation'),
      zoomOption: 'page', label: await page.locator('.pdf-zoom-control .pdf-menu-button').innerText(), browserScale: await assertBrowserScale(page)};
    assert.equal(evidence.preTranslationRestore.presentation, 'layout'); assert.match(evidence.preTranslationRestore.label, /适合整页|Fit page/u); persist();
  } finally {await cdp.detach();}
}

async function exercisePdfPresentationUi(page, {result, prefix, shot, checkFocus, persist}) {
  const evidence = result.pdfUi;
  evidence.menus.push(await choosePdfOptionByKeyboard(page, '.pdf-presentation-control', 'readable', 'Space', checkFocus));
  await page.locator('.pdf-layout-viewer[data-pdf-presentation="readable"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.pdf-reading-paragraph')].some(element => /\p{Script=Han}/u.test(element.textContent)));
  await waitPdfFrames(page);
  const screenshot = await shot(`${prefix}-pdf-ui-actual-translated-readable`); result.screenshots.push(screenshot); evidence.readableScreenshot = screenshot; persist();
  evidence.menus.push(await choosePdfOptionByKeyboard(page, '.pdf-presentation-control', 'layout', 'Enter', checkFocus));
  await page.locator('.pdf-layout-viewer[data-pdf-presentation="layout"]').waitFor();
  evidence.menus.push(await choosePdfOptionByKeyboard(page, '.pdf-zoom-control', 'page', 'Space', checkFocus));
  const label = await page.locator('.pdf-zoom-control .pdf-menu-button').innerText(); assert.match(label, /适合整页|Fit page/u);
  evidence.finalRestore = {presentation: 'layout', zoomOption: 'page', label, browserScale: await assertBrowserScale(page)}; evidence.ok = true; persist();
}

async function main() {
  const builtinGlossary = parseBuiltinGlossaryArg(process.argv.slice(2));
  const translationResumes = parseTranslationResumesArg(process.argv.slice(2));
  const repository = path.resolve(__dirname, '../..'), requireRepo = createRequire(path.join(repository, 'package.json'));
  const examples = path.resolve(arg('example-dir', path.join(repository, 'tests/fixtures/document-translation')));
  const defaults = [path.resolve(repository, '../BabelDOC-APP/docs/1706.03762v7.pdf'),
    ...['pdf', 'docx', 'html', 'epub', 'md', 'txt', 'srt', 'json'].map(extension => path.join(examples, `sample.${extension}`)),
    path.join(repository, 'docs/en/guide/document-translation.md')];
  const inputs = arg('inputs', defaults.join(',')).split(',').map(file => path.resolve(file.trim())).filter(Boolean);
  const exercisePdfUi = process.argv.includes('--exercise-pdf-ui');
  assert(!exercisePdfUi || inputs.some(file => /\.pdf$/iu.test(file)), '--exercise-pdf-ui requires an actual PDF input');
  assert(inputs.length && inputs.every(file => fs.existsSync(file) && fs.statSync(file).isFile()), '--inputs must name existing files (comma separated)');
  assert.equal(new Set(inputs.map(file => path.basename(file))).size, inputs.length, 'Input basenames must be unique for unambiguous history evidence');
  const extensionDir = path.resolve(arg('extension-dir', path.join(repository, '.output/chrome-mv3')));
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')) && !/-dev$/u.test(extensionDir), 'A production extension is required');
  const packages = arg('playwright-root'); assert(packages, '--playwright-root is required');
  const {chromium} = createRequire(path.join(packages, 'document-live-runner.cjs'))('playwright');
  const translationTimeout = Number(arg('translation-timeout-ms', 900000)), exportTimeout = Number(arg('export-timeout-ms', 180000));
  assert(Number.isFinite(translationTimeout) && translationTimeout >= 1000 && Number.isFinite(exportTimeout) && exportTimeout >= 1000);
  const samplePages = arg('pdf-pages', '1,3,5,8,10').split(',').map(Number); assert(samplePages.every(page => Number.isInteger(page) && page > 0));
  const capturePages = count => !process.argv.includes('--pdf-pages') && count <= samplePages.length
    ? Array.from({length: count}, (_value, index) => index + 1) : samplePages.filter(number => number <= count);
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-document-live-translation'));
  const service = arg('service', 'freeTranslation'); assert(['freeTranslation', 'bilibili', 'microsoft', 'google'].includes(service), '--service only allows credential-free freeTranslation,bilibili,microsoft,google');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const pdftoppm = arg('pdftoppm', 'pdftoppm');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-live-'));
  const report = {ok: false, artifactKind: 'production', extensionDir, artifactsDir, nodeVersion: process.version, driverSha256: sha(fs.readFileSync(__filename)),
    httpEvidenceDecoderSha256: sha(fs.readFileSync(require.resolve('./document-live-http-evidence.cjs'))),
    build: directoryFingerprint(extensionDir), manifestSha256: sha(fs.readFileSync(path.join(extensionDir, 'manifest.json'))), declaredBuildCommit: arg('build-commit', null),
    sourceSha256: Object.fromEntries(['src/app/document-translation/DocumentApp.vue', 'src/features/document-translation/services/binary.ts', 'src/features/document-translation/services/archive.ts',
      'src/features/document-translation/core/document.ts', 'src/features/document-translation/core/pdfLayoutAnalysis.ts', 'src/features/document-translation/ui/PdfReader.vue',
      'src/providers/translation/free-chinese-web.ts', 'src/providers/translation/free-translation.ts', 'src/core/translation/documentLiterals.ts',
      'src/services/translation/broker.ts', 'src/services/translation/glossaryProtection.ts', 'src/features/document-translation/ui/documentZoom.ts',
      'src/core/i18n/messages/pdfReading.ts', 'src/core/glossary/builtins.ts'].map(file => [file, sha(fs.readFileSync(path.join(repository, file)))])),
    parameters: {service, sourceLanguage: 'en', targetLanguage: 'zh-Hans', translationTimeout, translationResumes, exportTimeout, samplePages,
      shortPdfAllPages: !process.argv.includes('--pdf-pages'), readablePdfFirst: process.argv.includes('--readable-pdf-first'), exercisePdfUi, builtinGlossary,
      viewport: {width: 1440, height: 960}, narrowViewports: [{width: 820, height: 960}, {width: 390, height: 844}]},
    evidenceBoundary: `Real credential-free ${service} requests and actual document UI; no routes, fetch replacements, proxy, paid credentials or synthetic responses. Chinese/no-marker checks and two targeted inline-text regression assertions are evidence, not a general translation-quality score. Optional PDF UI coverage uses CDP keyboard and Ctrl/Cmd wheel against the actual document, not physical trackpad gestures. First-PDF narrow screenshots/geometry cover only 820x960 and 390x844. Review saved paragraphs and screenshots manually.`,
    documents: [], screenshots: [], network: [], consoleErrors: [], cleanupErrors: [], focusEvents: [], focusChecks: []};
  let launched, page, launchAttempted = false, focusMonitor, ownedPid, focusFailure;
  const responseObserver = createResponseBodyObserver(); report.responseBodyObservations = responseObserver.stats;
  const persist = () => fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  const stopForFocus = error => {
    focusFailure ||= error; report.focusFailure ||= error.message; persist();
    // 只关闭已确认的本次实例；永久保留焦点失败，不把后续关闭成功当成验证通过。
    if (launched) void launched.close().catch(error => {report.cleanupErrors.push(String(error));});
  };
  const checkFocus = async phase => {
    report.currentPhase = phase;
    if (focusFailure) throw focusFailure;
    const application = await queryMacFrontmostApplication();
    report.focusChecks.push({phase, document: report.currentDocument ?? null, time: Date.now(), application});
    if (!application || application.pid === ownedPid) {
      const error = new Error(!application ? `Cannot confirm foreground application during ${phase}` : `Owned Edge ${ownedPid} became foreground during ${phase}`);
      stopForFocus(error); throw error;
    }
  };
  try {
    report.currentPhase = 'launch';
    focusMonitor = startFocusEventMonitor({
      onEvent: event => {
        report.focusEvents.push({...event, phase: report.currentPhase, document: report.currentDocument ?? null});
        if (ownedPid && event.pid === ownedPid) stopForFocus(new Error(`Owned Edge ${ownedPid} activation during ${report.currentPhase}`));
      },
      onError: error => stopForFocus(error),
    });
    report.focusObserver = await focusMonitor.ready;
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, displayTarget: arg('display', 'secondary'), viewport: report.parameters.viewport, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    ownedPid = await getGuardedBrowserPid(launched); report.ownedBrowserPid = ownedPid;
    if (report.focusEvents.some(event => event.pid === ownedPid)) stopForFocus(new Error(`Owned Edge ${ownedPid} activation during launch`));
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground'); assert.equal(report.windowPlacement.browserFrontmost, false);
    await checkFocus('initialization');
    const context = launched.context, requests = new Map();
    context.on('request', request => {
      const url = new URL(request.url()); if (url.protocol !== 'https:') return;
      const record = {id: report.network.length + 1, document: report.currentDocument ?? null, domain: url.hostname,
        providerCandidate: isProviderDomain(url.hostname), method: request.method(), startedAt: Date.now(), resourceType: request.resourceType()};
      if (record.providerCandidate) {
        const decoded = decodeHttpTranslationRequest({url: request.url(), method: request.method(), postData: request.postData()});
        record.httpEvidence = {endpoint: decoded.endpoint, classification: decoded.classification, reason: decoded.reason,
          requestSlotCount: decoded.slots.length, slots: decoded.slots.map(slot => ({id: slot.id, sha256: sha(slot.text), chars: slot.text.length}))};
        record.sources = decoded.slots.length ? record.httpEvidence.slots.map(({sha256, chars}) => ({sha256, chars})) : requestSourceHashes(request);
      }
      requests.set(request, record); report.network.push(record);
    });
    context.on('response', response => {
      const record = requests.get(response.request()); if (!record) return;
      record.status = response.status(); record.elapsedMs = Date.now() - record.startedAt;
      // Only translation responses are read; temporary authentication/CSRF responses are never retained or inspected.
      if (!shouldObserveResponseBody(record, response)) return;
      responseObserver.observe(response, record);
    });
    context.on('requestfailed', request => {const record = requests.get(request); if (record) {record.failure = request.failure()?.errorText ?? 'request failed'; record.elapsedMs = Date.now() - record.startedAt;}});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    page = await newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
    // Keep diagnostic text short and exclude URLs/query strings that could contain upstream protocol identifiers.
    const diagnostic = text => String(text).replace(/https?:\/\/[^\s]+/gu, '[url]').slice(0, 500);
    page.on('pageerror', error => report.consoleErrors.push(diagnostic(error.message)));
    await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'}); await activateExtensionTabWithoutForeground(context, page);
    await page.locator('.file-drop-zone').waitFor();
    report.config = await page.evaluate(async service => {
      const patch = {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, service, documentService: service, from: 'en', to: 'zh-Hans'};
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); if (!stored.success) throw new Error('Public configuration read failed');
      const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const saved = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected, clientId: `document-live-${crypto.randomUUID()}`, sequence: 1});
      if (!saved.success) throw new Error(saved.error || 'Free-service patch failed');
      return {service: patch.service, documentService: patch.documentService, from: patch.from, to: patch.to,
        freeTranslationOrder: current.freeTranslationOrder, freeTranslationMode: current.freeTranslationMode, freeTranslationTimeoutMs: current.freeTranslationTimeoutMs};
    }, service);
    assert.equal(report.config.service, service);
    await page.reload({waitUntil: 'domcontentloaded'}); await page.locator('.file-drop-zone').waitFor();
    const shot = async name => {const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file); return file;};
    if (builtinGlossary) {
      report.glossarySetup = await installBuiltinGlossaryForLiveRun({page, origin, presetId: builtinGlossary, checkFocus});
      await checkFocus('builtin-glossary-imported-evidence');
      report.glossarySetup.screenshot = await shot('builtin-glossary-ai-en-zh-hans-imported'); persist();
      await checkFocus('builtin-glossary-document-return');
      await page.goto(origin + '/document.html', {waitUntil: 'domcontentloaded'}); await page.locator('.file-drop-zone').waitFor();
    }
    report.glossary = await page.evaluate(readPublicGlossaryState, builtinGlossary);
    if (builtinGlossary) assert.deepEqual(report.glossary, report.glossarySetup.selected, 'Document page must read the actual imported glossary selection');
    persist();
    if (exercisePdfUi) {
      await checkFocus('pdf-ui-homepage-ocr-note');
      const note = page.locator('.landing-section .local-processing-note'); await note.waitFor();
      const text = (await note.innerText()).trim();
      report.pdfUiHomepage = {text, html: await note.evaluate(element => element.outerHTML),
        screenshot: await shot('pdf-ui-homepage-ocr-note'), scope: 'Landing page before importing the actual PDF; no OCR request is started'}; persist();
      assert.match(text, /文件在本地解析/u); assert.match(text, /待译文字.*发送.*翻译服务/u);
      assert.match(text, /扫描版\s*PDF.*开始翻译时先识别文字/u);
      assert(!/暂不支持|不支持文字识别/u.test(text), 'Landing page must not claim scanned PDF OCR is unavailable');
    }
    const downloadFromDialog = (dialog, result, prefix, phase) => waitForDocumentDownload(page, dialog, {
      timeout: exportTimeout,
      click: () => dialog.locator('.translate-document-button').click(),
      assertActive: () => {
        if (focusFailure) throw focusFailure;
        if (page.isClosed()) throw new Error(`Document page closed during ${phase}`);
      },
      onProductError: async text => {
        result.downloadFailure = {kind: 'product-error', phase, observedAt: Date.now(), text: diagnostic(text), screenshot: null};
        persist();
        if (focusFailure) throw focusFailure;
        result.downloadFailure.screenshot = await shot(`${prefix}-${phase}-product-error`).catch(error => {
          result.downloadFailure.screenshotError = diagnostic(error.message); return null;
        });
        if (result.downloadFailure.screenshot) result.screenshots.push(result.downloadFailure.screenshot);
        persist();
      },
    });
    const clearForImport = async () => {
      const openDownload = page.locator('.download-dialog[open]'); if (await openDownload.count()) await openDownload.getByRole('button', {name: '返回文档', exact: true}).click();
      const sidebar = page.locator('aside.document-sidebar'); if (!await sidebar.isVisible()) await page.locator('.sidebar-toggle').click();
      await sidebar.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
      await page.locator('.document-settings-dialog[open] .sidebar-change-file').click();
      const confirmation = page.locator('dialog[open]').filter({has: page.locator('#confirm-document-heading')}); if (await confirmation.count()) await confirmation.locator('.translate-document-button').click();
      await page.locator('.file-drop-zone').waitFor();
    };
    let exercisedPdfUi = false;
    for (const [index, input] of inputs.entries()) {
      const name = path.basename(input), prefix = `${index + 1}-${slug(name)}`, isPdf = /\.pdf$/iu.test(name), bytes = fs.readFileSync(input);
      report.currentDocument = name;
      const result = {input, name, inputBytes: bytes.length, sha256: sha(bytes), state: 'importing', screenshots: [], statuses: []}; report.documents.push(result); persist();
      try {
        await checkFocus('import');
        const sourcePages = isPdf ? await inspectPdf(bytes, requireRepo) : undefined;
        result.sourcePages = sourcePages?.length;
        const importStart = Date.now(); await page.locator('input[type=file]').setInputFiles(input);
        await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor();
        if (isPdf) await page.locator('.pdf-page-row[data-render-state="ready"] canvas').first().waitFor();
        result.importMs = Date.now() - importStart;
        result.documentBatchTranslation = await page.locator('.document-batch-translation input').isChecked();
        assert.equal(result.documentBatchTranslation, true, 'New documents should use the default transient batching');
        result.glossary = await page.evaluate(readPublicGlossaryState, builtinGlossary);
        if (builtinGlossary) assert.deepEqual(result.glossary, report.glossary, 'Each document must retain the actual enabled builtin selection before translation');
        if (exercisePdfUi && isPdf && !exercisedPdfUi) {
          exercisedPdfUi = true;
          await exercisePdfZoomUi(page, {result, prefix, shot, checkFocus, persist});
        }
        const readResumeSettings = async () => ({...await page.evaluate(readPublicResumeSettings),
          glossary: await page.evaluate(readPublicGlossaryState, builtinGlossary), inputSha256: sha(fs.readFileSync(input))});
        const resumeSettings = translationResumes ? await readResumeSettings() : null;
        const started = Date.now(); result.state = 'translating';
        const resumeGuard = createTranslationResumeGuard({limit: translationResumes, started, timeout: translationTimeout, settings: resumeSettings});
        if (translationResumes) {
          result.translationFailures = resumeGuard.failures; result.recoveries = resumeGuard.recoveries;
          result.resumeSettings = resumeSettings; result.originalTranslationDeadline = resumeGuard.deadline;
        }
        const assertTranslationActive = () => {
          if (focusFailure) throw focusFailure;
          if (page.isClosed()) throw new Error('Document page closed during translation recovery');
        };
        const readTranslationStatus = () => page.evaluate(readProductionTranslationStatus);
        await checkFocus('translation');
        await page.locator('.taskbar-actions .translate-document-button').filter({hasText: '开始翻译'}).click();
        let lastStatus = '', lastLog = 0;
        while (Date.now() - started < translationTimeout) {
          assertTranslationActive();
          const current = await readTranslationStatus();
          if (current.status !== lastStatus) {lastStatus = current.status; result.statuses.push({...current, elapsedMs: Date.now() - started}); persist();}
          if (Date.now() - lastLog > 30000 || current.progress === 100) {lastLog = Date.now(); console.log(JSON.stringify({stage: 'translation', name, ...current, elapsedMs: Date.now() - started}));}
          if (current.status.startsWith('翻译完成')) {result.state = 'complete'; break;}
          if (isTranslationTimeoutSettling(current)) {
            await pause(Math.min(500, Math.max(0, resumeGuard.deadline - Date.now())));
            continue;
          }
          if (/翻译中断|已暂停|译文与原文相同/u.test(current.status) || current.error) {
            const resumed = await resumeGuard.tryResume(current, {
              readSnapshot: () => historySnapshot(page, name), readSettings: readResumeSettings, assertActive: assertTranslationActive, persist,
              saveFailure: async (failure, snapshot) => {
                const stem = `${prefix}-translation-failure-${failure.number}`;
                if (snapshot) {failure.segmentData = path.join(artifactsDir, `${stem}-segments.json`); fs.writeFileSync(failure.segmentData, JSON.stringify(snapshot, null, 2));}
                failure.screenshot = await shot(stem); result.screenshots.push(failure.screenshot); persist();
                fs.writeFileSync(path.join(artifactsDir, `${stem}.json`), JSON.stringify({...failure, capturePhase: 'Before any continue action'}, null, 2));
              },
              activateContinue: () => activateProductionTranslationContinue({page, checkFocus, number: resumeGuard.recoveries.length + 1,
                deadline: resumeGuard.deadline, readStatus: readTranslationStatus}),
            });
            if (!resumed) throw new Error(`Product translation stopped: ${current.status} ${current.error}`);
            result.state = 'translating'; lastStatus = ''; persist();
            console.log(JSON.stringify({stage: 'translation-continued', name, ...resumeGuard.recoveries.at(-1)}));
            await pause(Math.min(500, Math.max(0, resumeGuard.deadline - Date.now())));
            continue;
          }
          await pause(500);
        }
        result.translationMs = Date.now() - started;
        if (result.state !== 'complete') {
          const cancel = page.locator('.pause-button'); if (await cancel.isVisible()) await cancel.click();
          throw new Error(`Translation timeout after ${translationTimeout}ms`);
        }
        let snapshot;
        for (let attempt = 0; attempt < 40; attempt++) {snapshot = await historySnapshot(page, name); if (snapshot?.segments.length && snapshot.segments.every(segment => segment.translation.trim())) break; await pause(250);}
        assert(snapshot?.segments.length, 'Completed document should have a saved source snapshot');
        if (translationResumes) result.recoveryValidation = await resumeGuard.verifyFinal(snapshot, readResumeSettings);
        result.segments = snapshot.segments.length;
        const completed = snapshot.segments.filter(segment => segment.translation.trim()), chinese = completed.filter(segment => /\p{Script=Han}/u.test(segment.translation));
        result.translationChecks = {allSegmentsCompleted: completed.length === snapshot.segments.length, chineseSegments: chinese.length,
          noProtocolOrMockMarkers: snapshot.segments.every(segment => !MOCK_MARKER.test(segment.translation)),
          distinctSegments: completed.filter(segment => compact(segment.source) !== compact(segment.translation)).length};
        await responseObserver.drain();
        snapshot.segments.forEach(segment => {
          segment.sourceSha256 = sha(segment.source); segment.translationSha256 = sha(segment.translation);
          segment.upstreamMatches = report.network.filter(request => request.document === name && request.translations?.some(translation => translation.sha256 === segment.translationSha256)).map(request => ({request: request.id, domain: request.domain, status: request.status}));
        });
        result.segmentData = path.join(artifactsDir, `${prefix}-segments.json`); fs.writeFileSync(result.segmentData, JSON.stringify(snapshot, null, 2));
        assert(result.translationChecks.allSegmentsCompleted && chinese.length > 0 && result.translationChecks.noProtocolOrMockMarkers && result.translationChecks.distinctSegments > 0,
          `Live result validation failed: ${JSON.stringify(result.translationChecks)}`);
        await page.getByRole('button', {name: '阅读', exact: true}).click();
        await checkFocus('reading');
        await page.getByRole('group', {name: '阅读方式', exact: true}).getByRole('button', {name: '双语', exact: true}).click();
        if (isPdf) {
          assert.equal(await page.locator('.pdf-layout-viewer').getAttribute('data-pdf-presentation'), 'layout', 'Each ordinary PDF case must start with the default layout presentation');
          if (result.pdfUi) await exercisePdfPresentationUi(page, {result, prefix, shot, checkFocus, persist});
          await page.locator('.pdf-zoom-control .pdf-menu-button').click(); await page.locator('.pdf-zoom-control [data-value="page"]').click();
          if (index === 0) {
            result.responsive = [];
            try {
              for (const viewport of report.parameters.narrowViewports) {
                await checkFocus(`responsive-${viewport.width}`);
                await page.setViewportSize(viewport);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const geometry = await page.evaluate(() => {
                  const bar = document.querySelector('.document-taskbar');
                  const visible = element => Boolean(element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
                  const rect = element => {const bounds = element.getBoundingClientRect(); return {x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom};};
                  const controls = [...bar.querySelectorAll('button,.el-select__wrapper,.pdf-page-navigation input')].filter(element => visible(element) && !element.closest('.taskbar-notices'))
                    .map(element => ({name: element.getAttribute('aria-label') || element.textContent.trim() || element.className, ...rect(element)}));
                  const overlaps = [];
                  for (let at = 0; at < controls.length; at++) for (let next = at + 1; next < controls.length; next++) {
                    const a = controls[at], b = controls[next];
                    if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) overlaps.push([a.name, b.name]);
                  }
                  const pdfGroups = [...bar.querySelector('.pdf-viewer-toolbar').children].map(element => ({name: element.className, visible: visible(element), ...rect(element)}));
                  return {width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth, controls, overlaps, pdfGroups,
                    outside: controls.filter(item => item.x < -1 || item.right > innerWidth + 1 || item.y < -1 || item.bottom > innerHeight + 1),
                    readEditButtons: [...bar.querySelectorAll('.reader-tabs button')].filter(visible).length,
                    readingModeButtons: [...bar.querySelectorAll('[aria-label="阅读方式"] button')].filter(visible).length,
                    settingsVisible: visible(bar.querySelector('.toolbar-settings-toggle')),
                    downloadVisible: visible(bar.querySelector('.download-button'))};
                });
                const screenshot = await shot(`${prefix}-reader-responsive-${viewport.width}x${viewport.height}`);
                result.screenshots.push(screenshot); result.responsive.push({...geometry, screenshot}); persist();
                assert(geometry.bodyWidth <= viewport.width + 1 && !geometry.outside.length, `Actual translated toolbar exceeds ${viewport.width}px: ${JSON.stringify(geometry.outside)}`);
                assert.equal(geometry.overlaps.length, 0, `Actual translated toolbar controls overlap: ${JSON.stringify(geometry.overlaps)}`);
                assert(geometry.pdfGroups.length && geometry.pdfGroups.every(group => group.visible && group.x >= -1 && group.right <= viewport.width + 1), 'Complete PDF control groups must remain visible and inside the viewport');
                assert.equal(geometry.readEditButtons, 2); assert.equal(geometry.readingModeButtons, 3);
                assert(geometry.settingsVisible && geometry.downloadVisible, 'Narrow layouts must retain translation settings and download entry points');
                if (builtinGlossary && viewport.width === 390) {
                  await checkFocus('responsive-390-translated-evidence');
                  const paragraph = page.locator('.pdf-page-row[data-page-number="1"] .translated .pdf-translation-text').filter({hasText: /\p{Script=Han}/u}).first();
                  await paragraph.scrollIntoViewIfNeeded(); await paragraph.waitFor({state: 'visible'});
                  const text = await paragraph.innerText(); assert.match(text, /\p{Script=Han}/u);
                  const translatedScreenshot = await shot(`${prefix}-reader-responsive-390x844-translated`);
                  result.screenshots.push(translatedScreenshot);
                  result.responsive.at(-1).translatedEvidence = {screenshot: translatedScreenshot, textSha256: sha(text),
                    segmentIndex: await paragraph.locator('..').getAttribute('data-pdf-segment-index'),
                    scope: 'Actual translated column scrolled into the 390px viewport; no physical trackpad test'};
                  await checkFocus('responsive-390-translated-evidence-complete'); persist();
                }
              }
            } finally {
              await page.setViewportSize(report.parameters.viewport);
              await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            }
            if (result.pdfUi) {
              await checkFocus('pdf-ui-responsive-restored');
              result.pdfUi.responsiveRestore = {viewport: report.parameters.viewport, browserScale: await assertBrowserScale(page),
                presentation: await page.locator('.pdf-layout-viewer').getAttribute('data-pdf-presentation'),
                zoomLabel: await page.locator('.pdf-zoom-control .pdf-menu-button').innerText()};
              assert.equal(result.pdfUi.responsiveRestore.presentation, 'layout'); assert.match(result.pdfUi.responsiveRestore.zoomLabel, /适合整页|Fit page/u); persist();
            }
          }
          for (const number of capturePages(sourcePages.length)) {
            await checkFocus(`reading-page-${number}`);
            const navigation = page.locator('.pdf-page-navigation input'); await navigation.fill(String(number)); await navigation.press('Enter');
            await page.locator(`.pdf-page-row[data-page-number="${number}"][data-render-state="ready"] .translated canvas`).first().waitFor();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            result.screenshots.push(await shot(`${prefix}-reader-page-${number}`));
          }
        } else {
          if (await page.locator('.rich-preview-frame').count()) await page.waitForFunction(() => document.querySelector('.rich-preview-frame')?.contentDocument?.querySelector('.fluentread-document-translated,.fr-document-translated,[data-document-translation]') || /\p{Script=Han}/u.test(document.querySelector('.rich-preview-frame')?.contentDocument?.body?.innerText || ''));
          result.screenshots.push(await shot(`${prefix}-reader-first-screen`));
        }
        await checkFocus('export-dialog');
        await page.locator('.download-button').click(); const dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
        await dialog.locator('.export-options button').first().click();
        await checkFocus('export-download');
        const exportStart = Date.now();
        const download = await downloadFromDialog(dialog, result, prefix, 'export-download');
        const output = path.join(artifactsDir, `${prefix}-bilingual${path.extname(input)}`); await download.saveAs(output);
        const exportMs = Date.now() - exportStart;
        await checkFocus('export-validation');
        result.export = {output, suggestedFilename: download.suggestedFilename(), exportMs, bytes: fs.statSync(output).size};
        if (isPdf) {
          const outputPages = await inspectPdf(fs.readFileSync(output), requireRepo); result.export.validation = validatePdf(sourcePages, outputPages);
          result.export.previews = [];
          for (const number of capturePages(outputPages.length)) {
            const target = path.join(artifactsDir, `${prefix}-export-page-${number}`);
            await promisify(execFile)(pdftoppm, ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '2200', '-png', output, target], {timeout: 60000, maxBuffer: 1024 * 1024});
            result.export.previews.push({page: number, path: `${target}.png`});
          }
          assert(result.export.validation.ok, `PDF reopening/page-order/dimensions failed: ${JSON.stringify(result.export.validation)}`);
          if (index === 0 && report.parameters.readablePdfFirst) {
            if (await dialog.count()) await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
            try {
              await checkFocus('readable-presentation');
              await page.locator('.pdf-presentation-control > .pdf-menu-button').click();
              await page.locator('.pdf-presentation-control [role="option"][data-value="readable"]').click();
              await page.locator('.pdf-layout-viewer[data-pdf-presentation="readable"]').waitFor();
              await page.locator('.download-button').click();
              const readableDialog = page.locator('.download-dialog[open]'); await readableDialog.waitFor();
              await readableDialog.locator('.export-options button').filter({hasText: '仅译文'}).click();
              await checkFocus('readable-export-download');
              const readableStart = Date.now();
              const readableDownload = await downloadFromDialog(readableDialog, result, prefix, 'readable-export-download');
              const readableOutput = path.join(artifactsDir, `${prefix}-readable-translated.pdf`); await readableDownload.saveAs(readableOutput);
              result.readableExport = {output: readableOutput, suggestedFilename: readableDownload.suggestedFilename(),
                exportMs: Date.now() - readableStart, bytes: fs.statSync(readableOutput).size, presentation: 'readable', mode: 'translated', previews: []}; persist();
              await checkFocus('readable-export-validation');
              const readablePages = await inspectPdf(fs.readFileSync(readableOutput), requireRepo);
              result.readableExport.validation = validateReadableCopyText(snapshot, readablePages);
              result.readableExport.extraction = path.join(artifactsDir, `${prefix}-readable-text-extraction.json`);
              fs.writeFileSync(result.readableExport.extraction, JSON.stringify({validation: result.readableExport.validation, pages: readablePages}, null, 2)); persist();
              for (const number of [...new Set([1, readablePages.length])]) {
                const target = path.join(artifactsDir, `${prefix}-readable-export-page-${number}`);
                await promisify(execFile)(pdftoppm, ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '2200', '-png', readableOutput, target], {timeout: 60000, maxBuffer: 1024 * 1024});
                result.readableExport.previews.push({page: number, path: `${target}.png`});
              }
              assert(result.readableExport.validation.ok, `Readable PDF Chinese copy text is incomplete or reordered: ${JSON.stringify(result.readableExport.validation)}`);
            } finally {
              // 显式恢复阅读与下载的双语原版对照，后续样本不得继承首份的重排状态。
              if (!focusFailure && !page.isClosed()) {
                await checkFocus('readable-restore-defaults');
                const restoreDialog = page.locator('.download-dialog[open]');
                if (await restoreDialog.count()) await restoreDialog.getByRole('button', {name: '返回文档', exact: true}).click();
                await page.getByRole('group', {name: '阅读方式', exact: true}).getByRole('button', {name: '双语', exact: true}).click();
                if (await page.locator('.pdf-layout-viewer').getAttribute('data-pdf-presentation') !== 'layout') {
                  await page.locator('.pdf-presentation-control > .pdf-menu-button').click();
                  await page.locator('.pdf-presentation-control [role="option"][data-value="layout"]').click();
                  await page.locator('.pdf-layout-viewer[data-pdf-presentation="layout"]').waitFor();
                }
                await page.locator('.download-button').click(); await restoreDialog.waitFor();
                await restoreDialog.locator('.export-options button').first().click();
                assert.equal(await restoreDialog.locator('.export-options button').first().getAttribute('aria-pressed'), 'true');
                await restoreDialog.getByRole('button', {name: '返回文档', exact: true}).click();
                result.readableRestore = {presentation: 'layout', previewMode: 'bilingual', outputMode: 'bilingual'}; persist();
              }
            }
          }
        } else {
          result.export.validation = await validateOtherDownload(bytes, fs.readFileSync(output), snapshot, requireRepo);
          await checkFocus('export-reopen');
          await clearForImport(); await page.locator('input[type=file]').setInputFiles(output);
          await page.locator('.workspace-heading h1').filter({hasText: path.basename(output)}).waitFor();
          await page.getByRole('button', {name: '阅读', exact: true}).click();
          await page.getByRole('group', {name: '阅读方式', exact: true}).getByRole('button', {name: '原文', exact: true}).click();
          await page.waitForFunction(() => /\p{Script=Han}/u.test(document.querySelector('.rich-preview-frame')?.contentDocument?.body?.innerText || document.querySelector('.reading-content')?.innerText || ''));
          result.export.reopenedScreenshot = await shot(`${prefix}-export-reopened-first-screen`);
          result.export.reopenedInProduct = true;
        }
        // 成功下载后页面会自行关闭弹窗；仅仍然打开时才操作返回按钮。
        if (await dialog.count()) await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
        await checkFocus('document-finished');
      } catch (error) {
        result.state = 'failed'; result.error = diagnostic(error.stack || String(error));
        persist();
        const pauseButton = page.locator('.pause-button'); if (await pauseButton.isVisible().catch(() => false)) await pauseButton.click().catch(() => {});
        result.screenshots.push(await shot(`${prefix}-failure`).catch(() => null));
        const snapshot = await historySnapshot(page, name).catch(() => null);
        if (snapshot && !result.segmentData) {result.segmentData = path.join(artifactsDir, `${prefix}-segments.json`); fs.writeFileSync(result.segmentData, JSON.stringify(snapshot, null, 2));}
        if (focusFailure) throw focusFailure;
      }
      await responseObserver.drain();
      const requestsForDocument = report.network.filter(request => request.document === name && request.providerCandidate);
      result.providerNetwork = {requests: requestsForDocument.length, successful: requestsForDocument.filter(request => request.status >= 200 && request.status < 300).length,
        httpEvidence: summarizeHttpEvidence(requestsForDocument),
        bodyObservations: Object.fromEntries(['pending', 'completed', 'timedOut', 'failed'].map(state => [state,
          requestsForDocument.filter(request => request.bodyObservation?.state === state).length])),
        byDomain: Object.fromEntries([...new Set(requestsForDocument.map(request => request.domain))].map(domain => [domain, {requests: requestsForDocument.filter(request => request.domain === domain).length,
          statuses: requestsForDocument.filter(request => request.domain === domain).map(request => request.status ?? request.failure ?? 'pending') }]))};
      if (result.state === 'complete' && !result.providerNetwork.successful) {result.state = 'failed'; result.error = 'No successful live free-provider requests observed; network evidence is required';}
      console.log(JSON.stringify({stage: 'document-finished', name, state: result.state, segments: result.segments, translationMs: result.translationMs, providers: result.providerNetwork, error: result.error})); persist();
      if (input !== inputs.at(-1)) {
        await checkFocus('change-document');
        await clearForImport();
      }
    }
    delete report.currentDocument;
    report.finalGlossary = await page.evaluate(readPublicGlossaryState, builtinGlossary);
    if (builtinGlossary) assert.deepEqual(report.finalGlossary, report.glossary, 'Actual builtin selection must remain unchanged after all documents');
    await checkFocus('completed'); report.finalFrontmostApplication = report.focusChecks.at(-1).application;
    report.ok = report.documents.every(document => document.state === 'complete') && report.consoleErrors.length === 0;
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    report.failure = String(error.stack || error).replace(/https?:\/\/[^\s]+/gu, '[url]');
    if (page) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {}); process.exitCode = 1;
  } finally {
    await closeLiveSession({launched, focusMonitor, profileDir, launchAttempted, report, responseObserver});
    if (focusFailure) {report.ok = false; process.exitCode = 1;}
    if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
    persist(); console.log(JSON.stringify({ok: report.ok, report: path.join(artifactsDir, 'report.json'), documents: report.documents.map(({name, state}) => ({name, state})), failure: report.failure}));
  }
}

module.exports = {createResponseBodyObserver, closeLiveSession, isProviderDomain, shouldObserveResponseBody,
  parseBuiltinGlossaryArg, readPublicGlossaryState, selectPublicDocumentGlossary, installBuiltinGlossaryForLiveRun,
  parseTranslationResumesArg, readPublicResumeSettings, readProductionTranslationStatus, isResumableTranslationTimeout, isTranslationTimeoutSettling,
  assertPreservedTranslations, createTranslationResumeGuard, activateProductionTranslationContinue};
if (require.main === module) main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
