import {hasDistinctTranslation} from '@/src/core/translation/result';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileScript, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import * as compositeTranslation from '@/src/core/config/compositeTranslation';
import * as catalog from '@/src/core/config/catalog';
import * as documentCore from '@/src/features/document-translation/core/document';
import * as presentation from '@/src/features/document-translation/ui/presentation';
import * as preview from '@/src/features/document-translation/core/preview';
import * as richPreviewSync from '@/src/features/document-translation/ui/richPreviewSync';
import * as pdfOcr from '@/src/features/document-translation/services/pdfOcr';
import * as documentTasks from '@/src/features/document-translation/ui/useDocumentTasks';
import * as downloadCopy from '@/src/app/document-translation/downloadCopy';
import * as materialResume from '@/src/app/document-translation/materialResume';
import {useConfigEditor} from '@/src/features/settings/model/useConfigEditor';
import {createDocumentImportWorkflow} from '@/src/features/document-translation/services/importWorkflow';
import {createDocumentRecognitionWorkflow} from '@/src/features/document-translation/services/recognitionWorkflow';
import {createDocumentExportWorkflow} from '@/src/features/document-translation/services/exportWorkflow';
import {generateDocumentArchive} from '@/src/features/document-translation/services/archive';
import {createDocumentHistoryCommitter} from '@/src/features/document-translation/services/historyCommitter';
import {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';
import * as materialPorts from '@/src/features/vocabulary/material/public';

const materialTransport = vi.hoisted(() => ({sendMessage: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: materialTransport.sendMessage}, extension: {inIncognitoContext: false}}}));

// 编译真实页面 setup，注入可控解析/翻译边界；可见控件与下载文件另由真实浏览器套件验证。
const require = createRequire(import.meta.url);
const filename = 'src/app/document-translation/DocumentApp.vue';
const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
const compiled = ts.transpileModule(compileScript(descriptor, {id: 'document-batch-test'}).content, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
}).outputText;
let state: Record<string, any>;
let scope: vue.EffectScope;
let parseFile: ReturnType<typeof vi.fn>;
let translate: ReturnType<typeof vi.fn>;
let download: ReturnType<typeof vi.fn>;
let persist: ReturnType<typeof vi.fn>;
let unload: (() => void)[];
const file = (name: string, text = name) => ({name, size: text.length, text: async () => text}) as File;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
};

beforeEach(async () => {
  unload = [];
  materialTransport.sendMessage.mockReset().mockImplementation(async (message: any) => ({success: true, data: message.action === 'generation' ? 0 : message.action === 'capture' ? {id: 'document-material', source: message.input.source, locator: message.input.locator} : null}));
  vi.stubGlobal('window', {matchMedia: () => ({matches: false}), removeEventListener: () => {}, setTimeout,
    document: {createElement: () => ({click: vi.fn()})}});
  parseFile = vi.fn(async (input: File) => documentCore.parseDocument(input.name, await input.text()));
  translate = vi.fn(async (segments, options) => {
    for (const segment of segments) if (!options.initialTranslations[segment.id]) {
      options.onSegment({id: segment.id, translation: `translated ${segment.source}`});
    }
  });
  download = vi.fn(async (document, translations, mode) => ({data: documentCore.renderDocument(document, translations, mode),
    fileName: documentCore.createDocumentDownloadName(document.fileName, mode), mimeType: 'text/plain'}));
  persist = vi.fn().mockResolvedValue(undefined);
  const api = {...materialPorts, ...catalog, ...compositeTranslation, ...documentCore, ...presentation, ...preview, ...richPreviewSync, ...pdfOcr, ...documentTasks, useConfigEditor, createPdfPageRecognizer: () => async () => [], hasDistinctTranslation, Config, TranslationRequestError, serializeTranslationError, createDocumentImportWorkflow, createDocumentRecognitionWorkflow, createDocumentExportWorkflow,
    documentRetryBackoff: {maxWaitMs: 0}, createDocumentHistoryCommitter,
    createDocumentHistory: () => ({list: async () => [], listChecked: async () => ({status: 'ok', entries: []}), load: async () => null, loadChecked: async () => ({status: 'ok', record: null}), save: async () => false, saveChecked: async () => ({status: 'unavailable'}), remove: async () => false, removeChecked: async () => ({status: 'unavailable'}), clear: async () => false}), documentHistoryId: async () => '',
    parseDocumentFile: parseFile, translateDocumentSegments: translate, createDocumentDownload: download, generateDocumentArchive,
    buildGlossaryRevision: () => '', runtimeConfig: new Config(), configReady: Promise.resolve(),
    subscribeConfig: () => () => {}, requestConfigPatch: persist,
    getMissingCredentialMessage: () => '', getTranslationServiceUnavailableMessage: () => '',
    getCustomOpenAIProvider: () => undefined, filterAvailableTranslationServices: (items: unknown) => items,
    withCustomOpenAIServiceOptions: (items: unknown) => items,
    useUiI18n: () => ({language: vue.ref('zh-CN'), t: (key: string) => key, translateLegacy: (text: string) => text}),
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((id: string) => {
    if (id === 'vue') return {...vue, onMounted: () => {}, onUnmounted: (fn: () => void) => unload.push(fn)};
    if (id === './index' || id === '@/src/app/document-translation' || id === '@/src/core/translation/result') return api;
    if (id === './downloadCopy') return downloadCopy;
    if (id === './materialResume') return materialResume;
    if (id === 'webextension-polyfill') return {runtime: {sendMessage: materialTransport.sendMessage}, extension: {inIncognitoContext: false}};
    if (id.startsWith('element-plus') || id.endsWith('.css') || id.endsWith('.vue')) return {};
    return require(id);
  }, exports);
  scope = vue.effectScope();
  state = scope.run(() => vue.proxyRefs(exports.default.setup({}, {expose: () => {}})))!;
  await vue.nextTick();
});

afterEach(() => {
  unload.forEach(fn => fn());
  scope?.stop();
  vi.unstubAllGlobals();
});

describe('document batch page lifecycle', () => {
  it('saves a material only after a document has a persisted file identity through the public material port', async () => {
    await state.loadFiles([file('material.txt', 'An original paragraph stays with its document.')]);
    await state.saveDocumentMaterial();
    expect(materialTransport.sendMessage).not.toHaveBeenCalled();
    state.documentQueue[0].historyId = 'a'.repeat(32);
    await state.saveDocumentMaterial();
    expect(materialTransport.sendMessage).toHaveBeenCalledWith({type: 'fluentReadMaterials', action: 'generation'});
    expect(materialTransport.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({type: 'fluentReadMaterials', action: 'capture', input: expect.objectContaining({
      source: {kind: 'document', fingerprint: 'a'.repeat(32), title: 'material.txt'},
      locator: expect.objectContaining({kind: 'document', fingerprint: 'a'.repeat(32), page: 1, quote: 'An original paragraph stays with its document.'}), generation: 0,
    })}));
    expect(state.documentMaterialId).toBe('document-material');
    expect(translate).not.toHaveBeenCalled();
  });

  it('reports a fatal failure immediately while still accepting successful results already requested', async () => {
    await state.loadFiles([file('partial.txt', 'First.\n\nSecond.')]);
    const pending = deferred<void>();
    let options: any;
    translate.mockImplementationOnce(async (_segments, controls) => {
      options = controls;
      await pending.promise;
      throw new Error('第 2 段文档翻译失败：invalid model');
    });
    const work = state.startTranslation();
    options.onFailure({id: 1, reason: '第 2 段文档翻译失败：invalid model'});
    expect(state.runState).toBe('failed');
    expect(state.translating).toBe(true);
    expect(state.statusLabel).toBe('document.translationProgress.collectingAfterFailure');
    expect(state.errorMessage).toContain('invalid model');
    options.onSegment({id: 0, translation: '已发请求返回成功'});
    expect(state.completedSegments).toBe(1);
    expect(state.progress).toBe(50);
    pending.resolve(); await work;
    expect(state.translating).toBe(false);
    expect(state.statusLabel).toBe('翻译中断');
    expect(state.translatedSegments).toEqual(['已发请求返回成功']);
  });

  it('counts only committed passages, holds progress during retry, and waits for task settlement before 100%', async () => {
    await state.loadFiles([file('progress.txt', 'First.\n\nSecond.\n\nThird.')]);
    state.editSegment(0, '已完成的译文');
    const pending = deferred<void>();
    let options: any;
    translate.mockImplementationOnce(async (_segments, controls) => {options = controls; await pending.promise;});
    const work = state.startTranslation();
    expect(state.progress).toBe(33);
    options.onRetry({attempt: 1, delayMs: 2000, reason: '429 rate limit'});
    options.onRetryStateChange({waiting: 2});
    expect(state.statusLabel).toBe('document.translationProgress.waitingRetry');
    expect(state.progress).toBe(33);
    options.onSegment({id: 1, translation: '第二段'});
    options.onSegment({id: 1, translation: '第二段更新'});
    expect(state.completedSegments).toBe(2);
    expect(state.progress).toBe(66);
    expect(state.retryNotice).toContain('429 rate limit');
    options.onRetryStateChange({waiting: 1});
    expect(state.statusLabel).toBe('document.translationProgress.waitingRetry');
    options.onRetryStateChange({waiting: 0});
    expect(state.statusLabel).toBe('正在翻译');
    expect(state.retryNotice).toBe('');
    options.onSegment({id: 2, translation: '第三段'});
    expect(state.completedSegments).toBe(3);
    expect(state.progress).toBe(99);
    expect(state.translationComplete).toBe(false);
    expect(state.batchCompletedCount).toBe(0);
    expect(state.statusLabel).toBe('document.translationProgress.finishing');
    pending.resolve();
    await work;
    expect(state.translationComplete).toBe(true);
    expect(state.batchCompletedCount).toBe(1);
    expect(state.progress).toBe(100);
    expect(state.statusLabel).toBe('翻译完成');
  });

  it('keeps progress and reviewed translations when recovering with another service or model', async () => {
    state.config.documentService = 'openai';
    state.config.documentModel.openai = 'gpt-4o-mini';
    await state.loadFiles([file('paper.txt', 'First.\n\nSecond.\n\nThird.')]);
    state.editSegment(0, '人工校订');
    const fingerprint = state.taskFingerprint;
    translate.mockImplementationOnce(async (_segments, options) => {
      options.onSegment({id: 1, translation: '保留已成功段落'});
      throw new Error('Model unavailable: 503');
    });
    await state.startTranslation();
    expect(state.runState).toBe('failed');
    expect(state.progress).toBe(66);
    expect(state.errorMessage).toBe('Model unavailable: 503');
    expect(state.translationActionLabel).toBe('document.translationRecovery.retry');
    state.config.documentModel.openai = 'gpt-4o';
    expect(state.currentFingerprint).not.toBe(fingerprint);
    expect(state.settingsChanged).toBe(false);
    expect(state.progress).toBe(66);
    state.config.documentService = 'google';
    expect(state.settingsChanged).toBe(false);
    state.confirmDialog = {showModal: vi.fn()};
    state.requestTranslation();
    await vi.waitFor(() => expect(state.translationComplete).toBe(true));
    expect(state.confirmDialog.showModal).not.toHaveBeenCalled();
    expect(translate.mock.calls[1][1]).toEqual(expect.objectContaining({serviceOverride: 'google', initialTranslations: ['人工校订', '保留已成功段落']}));
    expect(state.confirmedTranslationIds).toEqual([0]);
    expect(state.translatedSegments.slice(0, 2)).toEqual(['人工校订', '保留已成功段落']);
    expect(state.progress).toBe(100);
  });

  it('pauses retry waits to change service and ignores late retry and segment callbacks', async () => {
    await state.loadFiles([file('paper.txt', 'First.\n\nSecond.')]);
    const pending = deferred<void>();
    let options: any;
    translate.mockImplementationOnce(async (_segments, controls) => {options = controls; await pending.promise;});
    state.documentSettingsDialog = {showModal: vi.fn(), close: vi.fn()};
    const work = state.startTranslation();
    options.onSegment({id: 0, translation: '已完成'});
    options.onRetry({attempt: 1, delayMs: 2000, reason: 'timeout'});
    options.onRetryStateChange({waiting: 1});
    state.pauseAndChangeService();
    expect(state.statusLabel).toBe('已暂停');
    expect(state.progress).toBe(50);
    expect(state.documentSettingsDialog.showModal).toHaveBeenCalledOnce();
    options.onRetryStateChange({waiting: 3});
    options.onRetry({attempt: 2, delayMs: 4000, reason: 'late retry'});
    options.onFailure({id: 1, reason: 'late failure'});
    options.onSegment({id: 1, translation: 'late result'});
    pending.resolve(); await work;
    expect(state.retryWaiting).toBe(0);
    expect(state.retryNotice).toBe('');
    expect(state.translatedSegments).toEqual(['已完成']);
    await state.startTranslation();
    expect(translate.mock.calls[1][1].initialTranslations).toEqual(['已完成']);
  });

  it('keeps progress accurate across existing translations, duplicate updates and clearing a result', async () => {
    await state.loadFiles([file('a.txt', 'First.\n\nSecond.\n\nThird.')]);
    state.editSegment(0, '已校订');
    const pending = deferred<void>();
    let options: any;
    translate.mockImplementationOnce(async (_segments, controls) => {
      options = controls;
      await pending.promise;
    });
    const work = state.startTranslation();
    expect(state.completedSegments).toBe(1);
    options.onSegment({id: 1, translation: '第二段'});
    expect(state.completedSegments).toBe(2);
    options.onSegment({id: 1, translation: '第二段再次更新'});
    expect(state.completedSegments).toBe(2);
    options.onSegment({id: 1, translation: '  '});
    expect(state.completedSegments).toBe(1);
    state.pauseTranslation();
    pending.resolve();
    await work;
    expect(state.completedSegments).toBe(1);
    expect(state.translatedSegments[0]).toBe('已校订');
    await state.startTranslation(true);
    expect(state.completedSegments).toBe(3);
    expect(state.translationComplete).toBe(true);
  });

  it('does not traverse or copy the whole translation array during incremental translation', async () => {
    await state.loadFiles([file('a.txt', 'First.')]);
    state.translating = true;
    await vue.nextTick();
    let reads = 0;
    state.translatedSegments = new Proxy(new Array(20_000), {get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    }});
    state.translatedSegments[0] = '第一段';
    reads = 0;
    await vue.nextTick();
    expect(reads).toBe(0);
    expect(state.settledTranslations).toEqual([]);
    state.translating = false;
    await vue.nextTick();
    expect(state.settledTranslations[0]).toBe('第一段');
    expect(reads).toBeGreaterThan(0);
  });

  it('cancels a ZIP export without marking queue items downloaded and can retry', async () => {
    await state.loadFiles([file('a.txt'), file('b.txt')]);
    await state.startBatch();
    const pending = deferred<any>();
    download.mockReturnValueOnce(pending.promise);
    const work = state.downloadBatch();
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const options = download.mock.calls[0][3];
    options.onPdfProgress({phase: 'saving', completedPages: 2, totalPages: 2});
    expect(state.batchNotice).toContain('document.export.saving');
    state.cancelDownload();
    pending.resolve({data: 'stale', fileName: 'a.txt', mimeType: 'text/plain'});
    await work;
    expect(options.signal.aborted).toBe(true);
    expect(state.batchNotice).toBe('document.export.canceled');
    expect(state.documentQueue.every((item: any) => item.downloaded === 0)).toBe(true);
    expect(state.preparingDownload).toBe(false);
    await state.downloadBatch();
    expect(state.batchNotice).toBe('document.batch.downloaded');
    expect(state.documentQueue.every((item: any) => item.downloaded === item.revision)).toBe(true);
  });

  it('keeps reviewed translations on export cancellation and permits retry', async () => {
    await state.loadFiles([file('a.txt', 'First.')]);
    state.editSegment(0, '第一段');
    state.partialExportAcknowledged = true;
    state.downloadDialog = {close: vi.fn()};
    const pending = deferred<any>();
    download.mockReturnValueOnce(pending.promise);
    const work = state.downloadDocument();
    const options = download.mock.calls[0][3];
    options.onPdfProgress({phase: 'rendering', completedPages: 1, totalPages: 50});
    expect(state.downloadProgress).toBe('document.export.pages');
    state.cancelDownload();
    expect(options.signal.aborted).toBe(true);
    expect(state.cancelingDownload).toBe(true);
    pending.resolve({data: 'stale', fileName: 'a.txt', mimeType: 'text/plain'});
    await work;
    expect(state.preparingDownload).toBe(false);
    expect(state.cancelingDownload).toBe(false);
    expect(state.downloadError).toBe('');
    expect(state.downloadProgress).toBe('document.export.canceled');
    expect(state.translatedSegments).toEqual(['第一段']);
    expect(state.downloadedRevision).toBe(0);
    expect(state.downloadDialog.close).not.toHaveBeenCalled();
    await state.downloadDocument();
    expect(state.downloadDialog.close).toHaveBeenCalledOnce();
    expect(state.downloadedRevision).toBe(state.editRevision);
  });

  it('stops export when the page unloads and does not mark it downloaded', async () => {
    await state.loadFiles([file('a.txt', 'First.')]);
    state.editSegment(0, '第一段');
    const pending = deferred<any>();
    download.mockReturnValueOnce(pending.promise);
    const work = state.downloadDocument();
    const options = download.mock.calls[0][3];
    state.resetDocument();
    expect(options.signal.aborted).toBe(true);
    pending.resolve({data: 'stale', fileName: 'a.txt', mimeType: 'text/plain'});
    await work;
    expect(state.preparingDownload).toBe(false);
    expect(state.downloadedRevision).toBe(0);
    expect(state.parsedDocument).toBe(null);
  });

  it('opens subtitle export in the reading mode and downloads the reviewed translation', async () => {
    await state.loadFiles([file('episode.srt', '1\n00:00:01,000 --> 00:00:03,000\nHello there.\n')]);
    state.editSegment(0, '校订后的字幕');
    state.previewMode = 'translated';
    // 本套件只运行 setup；模拟真实 dialog 的 @close="downloadOpen = false" 事件。
    state.downloadDialog = {showModal: vi.fn(), close: vi.fn(() => {state.downloadOpen = false;})};
    state.openDownload();
    expect(state.outputMode).toBe('translated');
    expect(state.downloadFileName).toBe('episode.translated.srt');
    expect(state.downloadPreview).toContain('校订后的字幕');
    expect(state.downloadPreview).not.toContain('Hello there.');
    await state.downloadDocument();
    expect(download).toHaveBeenCalledWith(state.parsedDocument, ['校订后的字幕'], 'translated', {
      pdfPresentation: 'layout', signal: expect.any(AbortSignal), onPdfProgress: expect.any(Function), onArchiveProgress: expect.any(Function),
    });
    expect((await download.mock.results[0].value).data).toContain('00:00:01,000 --> 00:00:03,000\n校订后的字幕');
    expect(state.downloadedRevision).toBe(state.editRevision);
    expect(state.downloadDialog.close).toHaveBeenCalledOnce();
    expect(state.downloadOpen).toBe(false);
    state.previewMode = 'bilingual';
    state.openDownload();
    expect(state.outputMode).toBe('bilingual');
    state.downloadDialog.close();
    state.previewMode = 'source';
    state.outputMode = 'translated';
    state.openDownload();
    expect(state.outputMode).toBe('translated');
  });

  it('permits the original-download dialog but blocks translation export while untranslated, busy or unconfirmed', async () => {
    const original = file('a.txt', 'First.\n\nSecond.');
    await state.loadFiles([original]);
    state.downloadDialog = {showModal: vi.fn(), close: vi.fn()};
    state.openDownload();
    expect(state.downloadDialog.showModal).toHaveBeenCalledOnce();
    expect(state.originalDownloadSource.blob).toBe(original);
    expect(state.hasTranslation).toBe(false);
    await state.downloadDocument();
    expect(download).not.toHaveBeenCalled();
    state.editSegment(0, '第一段');
    state.openDownload();
    expect(state.downloadDialog.showModal).toHaveBeenCalledOnce();
    await state.downloadDocument();
    expect(download).not.toHaveBeenCalled();
    state.partialExportAcknowledged = true;
    state.batchRunning = true;
    state.openDownload();
    expect(state.downloadDialog.showModal).toHaveBeenCalledOnce();
    expect(state.originalDownloadSource.blob).toBe(original);
    state.editSegment(0, '不应写入');
    await state.downloadDocument();
    expect(download).not.toHaveBeenCalled();
    expect(state.translatedSegments[0]).toBe('第一段');
    state.batchRunning = false;
    await state.downloadDocument();
    expect(download).toHaveBeenCalledOnce();
  });

  it('associates manual translations with their settings and ignores unknown segment IDs', async () => {
    await state.loadFiles([file('a.txt')]);
    state.editSegment(42, '无效片段');
    expect(state.completedSegments).toBe(0);
    state.editSegment(0, '人工翻译');
    expect(state.settingsChanged).toBe(false);
    state.config.to = 'ja';
    expect(state.settingsChanged).toBe(true);
    state.requestTranslation();
    expect(state.pendingAction).toBe('restart');
    expect(translate).not.toHaveBeenCalled();
  });

  it('opens settings on demand and restores saved translations after adding a file', async () => {
    state.documentSettingsDialog = {showModal: vi.fn(), close: vi.fn()};
    state.openDocumentSettings();
    expect(state.documentSettingsDialog.showModal).not.toHaveBeenCalled();
    await state.loadFiles([file('a.txt')]);
    state.openDocumentSettings();
    expect(state.documentSettingsDialog.showModal).toHaveBeenCalledOnce();
    state.editSegment(0, '第一份校订');
    await state.loadFiles([file('b.txt')]);
    // 新添加的文件成为当前文档，并展开侧栏的文件页；切回第一份时校订仍在。
    expect(state.parsedDocument.fileName).toBe('b.txt');
    expect(state.sidebarOpen).toBe(true); expect(state.sidebarTab).toBe('files');
    state.selectDocument(state.documentQueue[0]);
    expect(state.translatedSegments).toEqual(['第一份校订']);
    expect(state.downloadPreview).toBe('');
  });

  it('shows a failed settings save and prevents a late older failure replacing a newer success', async () => {
    persist.mockRejectedValueOnce(new Error('unavailable'));
    state.config.to = 'ja';
    await vue.nextTick(); await vue.nextTick();
    expect(state.configSaveError).toContain('设置未能保存');
    const old = deferred<void>();
    persist.mockImplementationOnce(() => old.promise.then(() => {throw new Error('old failure');}));
    state.config.to = 'en'; await vue.nextTick();
    state.config.to = 'fr'; await vue.nextTick(); await vue.nextTick();
    expect(state.configSaveError).toBe('');
    old.resolve(); await vue.nextTick(); await vue.nextTick();
    expect(state.configSaveError).toBe('');
  });

  it('imports every valid file and preserves per-file parsing failures and duplicate names', async () => {
    await state.loadFiles([file('same.txt', 'First.'), file('bad.json', '{'), file('same.txt', 'Second.')]);
    expect(state.documentQueue).toHaveLength(3);
    expect(state.documentQueue[1].error).toBeTruthy();
    expect(new Set(state.documentQueue.map((item: any) => item.id)).size).toBe(3);
    expect(state.parsedDocument.segments[0].source).toBe('First.');
    state.selectDocument(state.documentQueue[2]);
    expect(state.parsedDocument.segments[0].source).toBe('Second.');
  });

  it('continues after a translation failure and retries only unfinished files', async () => {
    await state.loadFiles([file('a.txt'), file('b.txt'), file('c.txt')]);
    translate.mockRejectedValueOnce(new Error('service failed'));
    await state.startBatch();
    expect(state.batchCompletedCount).toBe(2);
    expect(state.documentQueue[0].state).toBe('failed');
    expect(translate).toHaveBeenCalledTimes(3);
    await state.startBatch();
    expect(state.batchCompletedCount).toBe(3);
    expect(translate).toHaveBeenCalledTimes(4);
  });

  it('pauses the queue, rejects late segments, and resumes from committed translations', async () => {
    await state.loadFiles([file('a.txt', 'First.\n\nSecond.'), file('b.txt')]);
    const pending = deferred<void>();
    let firstOptions: any;
    translate.mockImplementationOnce(async (_segments, options) => {
      firstOptions = options;
      options.onSegment({id: 0, translation: 'keep this'});
      await pending.promise;
      options.onSegment({id: 1, translation: 'late result'});
    });
    const batch = state.startBatch();
    state.pauseTranslation();
    pending.resolve();
    await batch;
    expect(firstOptions.signal.aborted).toBe(true);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(state.translatedSegments).toEqual(['keep this']);
    await state.startBatch();
    expect(translate.mock.calls[1][1].initialTranslations).toEqual(['keep this']);
    expect(state.batchCompletedCount).toBe(2);
    state.selectDocument(state.documentQueue[0]);
    expect(state.translatedSegments[0]).toBe('keep this');
  });

  it('keeps manual corrections isolated across documents and protects removal', async () => {
    await state.loadFiles([file('a.txt'), file('b.txt')]);
    state.editSegment(0, 'manual correction');
    state.selectDocument(state.documentQueue[1]);
    expect(state.translatedSegments).toEqual([]);
    expect(state.hasUnsavedWork).toBe(true);
    state.selectDocument(state.documentQueue[0]);
    expect(state.translatedSegments).toEqual(['manual correction']);
    state.confirmDialog = {showModal: vi.fn(), close: vi.fn()};
    state.removeDocument(state.documentQueue[0]);
    expect(state.confirmDialog.showModal).toHaveBeenCalledOnce();
    expect(state.documentQueue).toHaveLength(2);
    state.confirmAction();
    expect(state.documentQueue).toHaveLength(1);
    expect(state.parsedDocument.fileName).toBe('b.txt');
  });

  it('does not erase partially translated work after settings change', async () => {
    await state.loadFiles([file('a.txt', 'First.\n\nSecond.')]);
    state.taskFingerprint = state.currentFingerprint;
    state.editSegment(0, 'reviewed text');
    state.config.to = 'ja';
    await state.startBatch();
    expect(translate).not.toHaveBeenCalled();
    expect(state.translatedSegments).toEqual(['reviewed text']);
    expect(state.batchNotice).toBe('document.batch.settingsChanged');
  });

  it('stops between files when an external setting changes', async () => {
    await state.loadFiles([file('a.txt'), file('b.txt')]);
    const pending = deferred<void>();
    translate.mockImplementationOnce(async (_segments, options) => {
      await pending.promise;
      options.onSegment({id: 0, translation: 'first language'});
    });
    const batch = state.startBatch();
    state.config.to = 'ja';
    pending.resolve();
    await batch;
    expect(translate).toHaveBeenCalledOnce();
    expect(state.batchRunning).toBe(false);
    expect(state.batchNotice).toBe('document.batch.externalSettings');
  });

  it('invalidates pending parsing on page reset without importing later files', async () => {
    const pending = deferred<documentCore.ParsedDocument>();
    parseFile.mockReturnValueOnce(pending.promise);
    const importing = state.loadFiles([file('a.txt'), file('b.txt')]);
    state.resetDocument();
    pending.resolve(documentCore.parseDocument('a.txt', 'Late file.'));
    await importing;
    expect(state.documentQueue).toEqual([]);
    expect(state.parsedDocument).toBeNull();
    expect(parseFile).toHaveBeenCalledOnce();
    expect(state.openingFile).toBe(false);
  });
});
