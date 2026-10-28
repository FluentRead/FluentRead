import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    // Complete linkedom's missing browser select setter; Vue still executes its real DOM patch.
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true, get() {return [...this.querySelectorAll('option')].find(o => o.selected)?.value || '';}, set(value) {for (const option of this.querySelectorAll('option')) option.selected = option.value === String(value);}});
    // linkedom creates details as HTMLElement without the native boolean open property.
    const createElement = document.createElement.bind(document);
    document.createElement = ((name: string, options?: unknown) => {
        const element = createElement(name, options as never);
        if (name === 'details') Object.defineProperty(element, 'open', {configurable: true, get() {return element.hasAttribute('open');}, set(value: boolean) {element.toggleAttribute('open', Boolean(value));}});
        return element;
    }) as typeof document.createElement;
    Object.defineProperty(document, 'visibilityState', {configurable: true, writable: true, value: 'visible'});
    return {window, document};
});
const ports = vi.hoisted(() => ({message: vi.fn(), watch: vi.fn(), stopWatch: vi.fn(), imageOcr: true}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.message}}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {get imageOcr() {return ports.imageOcr;}}}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {watch: ports.watch}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (s: string) => s, t: (s: string) => s})}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', async () => {
    const {defineComponent, h, provide} = await import('vue');
    // Only the third-party select port is controlled; real UiSelect and feature templates run.
    return {ClickOutside: {}, ElSelect: defineComponent({props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup(p, {slots, emit}) {
        provide('audit-select-port', {value: () => p.modelValue, disabled: () => p.disabled, select: (value: unknown) => emit('update:modelValue', value)});
        return () => h('div', {'data-select': '', 'aria-disabled': p.disabled}, slots.default?.());
    }})};
});
import {createApp, h, inject, nextTick, reactive, type App, type Component} from 'vue';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const {buildSync} = createRequire(createRequire(resolve(process.cwd(), 'package.json')).resolve('vite'))('esbuild');
import {createDocumentSegmentTranslator, type DocumentTranslationGateway} from '@/src/features/document-translation/services/translation';
import type {DocumentSegment} from '@/src/features/document-translation/core/document';
import {splitLocalTranslationText, assertLocalTranslationOutput, hunyuanTranslationPrompt} from '@/src/core/translation/localInference';
import {isLikelyPageContextLeak, isDefinitePageContextLeak} from '@/src/core/translation/prompts';
import {createLocalTranslationBackgroundRuntime} from '@/src/features/local-translation/background/runtime';
import {createLocalTranslationDownloadManager} from '@/src/features/local-translation/offscreen/downloads';
import {artifactUrl, getTranslationArtifacts, downloadTranslationArtifact, artifactComplete, translationArtifactBlob, MODEL_CHUNK_SIZE, type TranslationArtifact} from '@/src/features/local-translation/offscreen/artifactStore';
import {LOCAL_TRANSLATION_MODEL_IDS as ids} from '@/src/core/config/localTranslation';
import {createImageOcrLanguageRepository} from '@/src/features/image-translation/background/ocrLanguageRepository';
import {IMAGE_OCR_LANGUAGE_STATE_KEY} from '@/src/features/image-translation/ocrLanguages';
import ImageOcrSettings from '@/src/features/image-translation/ui/ImageOcrSettings.vue';
import MangaSettings from '@/src/features/image-translation/ui/MangaSettings.vue';
import MangaModelSettings from '@/src/features/image-translation/ui/MangaModelSettings.vue';
import {Config} from '@/src/core/config/model';

const explicitEvidence = process.env.AUDIT_E_EVIDENCE;
const evidence = explicitEvidence || mkdtempSync(resolve(tmpdir(), 'fluentread-audit49-e-'));
mkdirSync(evidence, {recursive: true});
afterAll(() => {if (!explicitEvidence) rmSync(evidence, {recursive: true, force: true});});
const root = process.cwd();
const baseline = process.env.AUDIT_E_BASELINE === '1';
const entries = new Map<string, Response>();
const apps = new Set<App>();
type StorageListener = (changes: Record<string, {newValue?: unknown}>, areaName: string) => void;
const progressListeners = new Set<StorageListener>();
const progressEvents = {
    addListener: vi.fn((listener: StorageListener) => {progressListeners.add(listener);}),
    removeListener: vi.fn((listener: StorageListener) => {progressListeners.delete(listener);}),
};
let failStateWrite = false;
let onPut: ((key: string) => void | Promise<void>) | undefined;
let onMatch: ((key: string) => void | Promise<void>) | undefined;
const keyOf = (key: RequestInfo | URL) => typeof key === 'string' ? key : key instanceof URL ? key.href : key.url;
const cachePort = {
    async match(input: RequestInfo | URL) {const key = keyOf(input); await onMatch?.(key); return entries.get(key)?.clone();},
    async keys(input: RequestInfo | URL, options?: {ignoreSearch?: boolean}) {
        const key = keyOf(input);
        return [...entries.keys()].filter(value => options?.ignoreSearch ? value.split('?')[0] === key.split('?')[0] : value === key).map(value => new Request(value));
    },
    async put(input: RequestInfo | URL, value: Response) {
        const key = keyOf(input);
        if (failStateWrite && key.endsWith('/local-translation-downloads-v2')) {failStateWrite = false; throw new Error('controlled state disk failure');}
        await onPut?.(key); entries.set(key, value.clone());
    },
    async delete(input: RequestInfo | URL) {return entries.delete(keyOf(input));},
};
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function settle() {for (let i = 0; i < 20; i++) {await Promise.resolve(); await nextTick();}}
async function mount(component: Component, props: Record<string, unknown> = {}) {
    const container = document.createElement('div'); document.body.append(container);
    const input = reactive(props); const app = createApp({render: () => h(component, input)});
    app.component('el-option', {props: {value: null, label: String, disabled: Boolean}, setup(p: {value?: unknown; label?: string; disabled?: boolean}) {
        const select = inject<{value: () => unknown; disabled: () => boolean; select: (value: unknown) => void}>('audit-select-port')!;
        return () => h('button', {type: 'button', 'data-option-value': String(p.value), 'aria-pressed': select.value() === p.value,
            disabled: p.disabled || select.disabled(), onClick: () => select.select(p.value)}, String(p.label));
    }});
    app.component('el-switch', {props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup(p: {modelValue?: boolean; disabled?: boolean}, {emit}: {emit: (name: 'update:modelValue', value: boolean) => void}) {
        return () => h('button', {role: 'switch', disabled: p.disabled, 'aria-checked': p.modelValue, onClick: () => emit('update:modelValue', !p.modelValue)});
    }});
    apps.add(app); app.mount(container); await settle(); return {container, app, props: input};
}
function segments(): DocumentSegment[] {return [{id: 0, source: 'one', role: 'paragraph'}, {id: 1, source: 'two', role: 'paragraph'}, {id: 2, source: 'three', role: 'paragraph'}] as DocumentSegment[];}
function gateway(batch = true): DocumentTranslationGateway {return {waitUntilReady() {}, getDefaultService: () => 'fixture', supportsBatch: () => batch, translateText: async text => 'translated ' + text, translateTextBatch: async texts => texts.map(s => 'translated ' + s)};}
function fileFor(body: Uint8Array): TranslationArtifact {return {repo: 'fixture/model', revision: 'immutable', path: 'model.bin', size: body.length, sha256: createHash('sha256').update(body).digest('hex')};}
beforeEach(() => {
    progressListeners.clear(); progressEvents.addListener.mockClear(); progressEvents.removeListener.mockClear();
    vi.stubGlobal('browser', {storage: {onChanged: progressEvents}});
    entries.clear(); onPut = undefined; onMatch = undefined; failStateWrite = false;
    ports.message.mockReset().mockImplementation(async ({type}) => type === 'fluentReadImageOcrStatus' ? {success: true, languages: [], states: {}} : {success: true, ready: false, bytes: 0, source: 'auto'});
    ports.stopWatch.mockReset(); ports.watch.mockReset().mockReturnValue(ports.stopWatch); ports.imageOcr = true;
    document.body.replaceChildren(); (document as any).visibilityState = 'visible';
    vi.stubGlobal('caches', {open: async () => cachePort, delete: async () => {entries.clear(); return true;}});
    vi.stubGlobal('navigator', {language: 'en', storage: {estimate: async () => ({quota: 10_000_000_000, usage: 0})}});
    vi.stubGlobal('fetch', vi.fn(async () => {throw new Error('unconfigured external port');}));
});
afterEach(async () => {
    try {
        for (const app of apps) app.unmount(); apps.clear(); await settle();
        expect(progressListeners.size).toBe(0);
    } finally {
        vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    }
});

describe('audit 49 E actual translation and cache entries', () => {
    it('rejects sparse document batch responses before committing any segment', async () => {
        const port = gateway(); port.translateTextBatch = async () => {const result = new Array<string>(3); result[0] = 'first'; result[2] = 'third'; return result;};
        const commit = vi.fn();
        await expect(createDocumentSegmentTranslator(port)(segments(), {fileName: 'fixture', onSegment: commit})).rejects.toThrow('片段不完整');
        expect(commit).not.toHaveBeenCalled();
    });
    it('stops document batch commits when a segment subscriber cancels the task', async () => {
        const controller = new AbortController(), commit = vi.fn(() => controller.abort());
        await expect(createDocumentSegmentTranslator(gateway())(segments(), {fileName: 'fixture', signal: controller.signal, onSegment: commit})).rejects.toMatchObject({name: 'AbortError'});
        expect(commit).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledWith({id: 0, translation: 'translated one'});
    });
    it('preserves resume, glossary exclusion and the frozen language pair', async () => {
        const port = gateway(false), request = vi.fn(port.translateText); port.translateText = request;
        port.getGlossaryOptions = () => ({glossaryIds: ['default']});
        const result = await createDocumentSegmentTranslator(port)(segments(), {fileName: 'fixture', initialTranslations: ['edited'], glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'});
        expect(result).toEqual(['edited', 'translated two', 'translated three']);
        expect(request.mock.calls.map(c => c[2])).toEqual([expect.objectContaining({glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'}), expect.objectContaining({glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'})]);
    });
    it('accepts only extension-owned offscreen progress through the real background runtime composition', async () => {
        const values: Record<string, unknown> = {}, writes = vi.fn(async (value: Record<string, unknown>) => {Object.assign(values, value);});
        vi.stubGlobal('browser', {runtime: {id: 'fixture', getURL: (path: string) => 'moz-extension://fixture/' + path.replace(/^\//u, '')}, storage: {local: {get: async () => values, set: writes}}});
        const handler = createLocalTranslationBackgroundRuntime().find(h => h.type === 'fluentReadLocalTranslationDownloadProgress')!;
        const message = {type: 'fluentReadLocalTranslationDownloadProgress', snapshot: {version: 2, tasks: [{model: ids.opusZhEn, phase: 'idle', downloadedBytes: 0, totalBytes: 100, bytesPerSecond: 0, updatedAt: 1}]}};
        expect(await handler.handle(message, {sender: {id: 'other', url: 'moz-extension://fixture/offscreen.html'}})).toEqual({success: false});
        expect(await handler.handle(message, {sender: {id: 'fixture', url: 'https://fixture.example/offscreen.html'}})).toEqual({success: false});
        expect(writes).not.toHaveBeenCalled();
        expect(await handler.handle(message, {sender: {id: 'fixture', url: 'moz-extension://fixture/offscreen.html'}})).toEqual({success: true});
        expect(writes).toHaveBeenCalledOnce();
    });
    it('releases the model removal lock after the initial state write fails and allows retry', async () => {
        const manager = createLocalTranslationDownloadManager(); await manager.status(); failStateWrite = true;
        await expect(manager.remove(ids.opusZhEn)).rejects.toThrow('controlled state disk failure');
        expect((await manager.status()).tasks.find(t => t.model === ids.opusZhEn)).toMatchObject({phase: 'error', error: 'storage'});
        const deleted = await manager.remove(ids.opusZhEn);
        expect(deleted.tasks.find(t => t.model === ids.opusZhEn)).toMatchObject({phase: 'idle', downloadedBytes: 0});
    });
    it('keeps a model paused when cancellation occurs during the final cached artifact lookup', async () => {
        const terminal = deferred<void>(); let terminalWrites = 0;
        const manager = createLocalTranslationDownloadManager({onChange: async snapshot => {
            const phase = snapshot.tasks.find(t => t.model === ids.opusZhEn)?.phase;
            if (phase === 'paused' || phase === 'ready') {if (++terminalWrites === 2) terminal.resolve();}
        }});
        await manager.status(); const files = getTranslationArtifacts(ids.opusZhEn);
        for (const file of files) {
            entries.set(artifactUrl(file) + '?fluent-read-verified=' + file.sha256, new Response('verified fixture receipt'));
            for (let index = 0; index < Math.ceil(file.size / MODEL_CHUNK_SIZE); index++) entries.set(`${artifactUrl(file)}?fluent-read-part=${index}`, new Response());
        }
        const last = files[files.length - 1]!; let paused = false;
        onMatch = async key => {if (!paused && key === artifactUrl(last) + '?fluent-read-verified=' + last.sha256) {paused = true; await manager.pause(ids.opusZhEn);}};
        await manager.start(ids.opusZhEn); await terminal.promise;
        expect((await manager.status()).tasks.find(t => t.model === ids.opusZhEn)?.phase).toBe('paused'); expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects a cancelled verified artifact lookup without reporting completion or fetching', async () => {
        const file = fileFor(new Uint8Array([1, 2, 3])), controller = new AbortController(), progress = vi.fn();
        entries.set(artifactUrl(file) + '?fluent-read-verified=' + file.sha256, new Response('verified'));
        onMatch = async key => {if (key.includes('verified=')) controller.abort();};
        await expect(downloadTranslationArtifact(file, controller.signal, progress)).rejects.toMatchObject({name: 'AbortError'});
        expect(progress).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects cancellation while a verified receipt write is pending and keeps valid cached bytes', async () => {
        const bytes = new Uint8Array([1, 2, 3]), file = fileFor(bytes), controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
        onPut = key => {if (key.includes('verified=')) controller.abort();};
        await expect(downloadTranslationArtifact(file, controller.signal, () => {})).rejects.toMatchObject({name: 'AbortError'});
        expect(await artifactComplete(file)).toBe(true); expect(new Uint8Array(await (await translationArtifactBlob(file)).arrayBuffer())).toEqual(bytes);
    });
    it('unlocks the actual response stream reader after a successful verified download', async () => {
        const bytes = new Uint8Array([9, 8, 7]), file = fileFor(bytes), response = new Response(bytes), reader = response.body!.getReader();
        const release = vi.spyOn(reader, 'releaseLock'); vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
        vi.stubGlobal('fetch', vi.fn(async () => response));
        await downloadTranslationArtifact(file, new AbortController().signal, () => {});
        expect(release).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false);
    });
    it('preserves sequential OCR language writes after a failed storage write', async () => {
        let saved: unknown = []; let failure = true;
        const repo = createImageOcrLanguageRepository({get: async () => ({[IMAGE_OCR_LANGUAGE_STATE_KEY]: saved}), set: async values => {if (failure) {failure = false; throw new Error('disk');} saved = values[IMAGE_OCR_LANGUAGE_STATE_KEY];}});
        const first = repo.markDownloaded(['eng']); const second = repo.markDownloaded(['jpn']);
        await expect(first).rejects.toThrow('disk'); expect(await second).toEqual(['jpn']);
        expect(await repo.markDownloaded(['eng'])).toEqual(['jpn', 'eng']); await repo.assertDownloaded('ja');
        expect(await repo.markRemoved(['eng'])).toEqual(['jpn']); await expect(repo.assertDownloaded('en')).rejects.toThrow('下载');
    });
    it('preserves exact local split output, whitespace, prompts and source-owned repetitions', () => {
        const input = 'A short sentence.\n\n' + '材料😀'.repeat(250) + ' End.';
        const output = splitLocalTranslationText(input);
        expect(output.join('')).toBe(input); expect(output.every(s => s.length <= 480 && !/[\uD800-\uDBFF]$/u.test(s))).toBe(true);
        expect(hunyuanTranslationPrompt('text', 'en', 'ja')).toContain('Japanese');
        expect(() => assertLocalTranslationOutput('abc'.repeat(20), 'abc'.repeat(20))).not.toThrow();
        expect(() => assertLocalTranslationOutput('abc'.repeat(20), 'different')).toThrow('REPETITION');
    });
    it('bounds invalid local split limits in an isolated loaded production-module process', async () => {
        let invalidBudgetError: unknown;
        try {splitLocalTranslationText('bounded text', NaN);} catch (error) {invalidBudgetError = error;}
        const variant = baseline ? 'baseline' : 'current', bundled = evidence + '/inference-' + variant + '.mjs';
        buildSync({entryPoints: [(baseline ? process.env.AUDIT_E_BASELINE_SOURCE_ROOT! : root) + '/src/core/translation/localInference.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundled, alias: {'@': root}, logLevel: 'silent'});
        const probe = evidence + '/probe-' + variant + '.mjs';
        writeFileSync(probe, `import {splitLocalTranslationText} from ${JSON.stringify(bundled)};\nimport assert from 'node:assert/strict';\nprocess.stdout.write('PRODUCTION_MODULE_LOADED\\n');\nfor (const limit of [1, 0, -1, 1.5, NaN, Infinity]) assert.throws(()=>splitLocalTranslationText('😀end', limit), RangeError);\nassert.deepEqual(splitLocalTranslationText('😀end',2),['😀','en','d']);\nprocess.stdout.write('PROBE_FINISHED\\n');\n`);
        const result = await new Promise<{exit: number | null; signal: string | null; loaded: boolean; timeout: boolean; output: string}>((resolve, reject) => {
            const child = spawn(process.execPath, [probe], {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
            let output = '', timeout = false, timer: ReturnType<typeof setTimeout>;
            child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {output += data;});
            timer = setTimeout(() => {timeout = true; try {process.kill(-child.pid!, 'SIGKILL');} catch {}}, 1500);
            child.once('error', error => {clearTimeout(timer); reject(error);});
            child.once('close', (exit, signal) => {clearTimeout(timer); resolve({exit, signal, loaded: output.includes('PRODUCTION_MODULE_LOADED'), timeout, output});});
        });
        writeFileSync(evidence + '/inference-probe-' + variant + '.json', JSON.stringify({...result, directNonFiniteBudgetError: invalidBudgetError instanceof Error ? invalidBudgetError.name : null}, null, 2));
        expect(result.loaded, 'module load must succeed before runtime classification').toBe(true);
        expect(result.timeout, result.output).toBe(false); expect(result.exit, result.output).toBe(0); expect(invalidBudgetError).toBeInstanceOf(RangeError);
    });
    it('bounds repeated CJK whole-string searches for normal paragraphs', () => {
        // 长源文继续验证词法检测的线性预算；短标题的极端扩写现会触发一次跨语言复验。
        const origin = 'Translate the paragraph about the original problem and preserve its meaning.';
        const context = Array.from({length: 3000}, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
        const result = Array.from({length: 1000}, (_, i) => String.fromCharCode(0x7000 + i)).join('');
        const originals = [
            [String.prototype, 'includes', Object.getOwnPropertyDescriptor(String.prototype, 'includes')!],
            [Set.prototype, 'add', Object.getOwnPropertyDescriptor(Set.prototype, 'add')!],
            [Set.prototype, 'has', Object.getOwnPropertyDescriptor(Set.prototype, 'has')!],
            [Set.prototype, 'delete', Object.getOwnPropertyDescriptor(Set.prototype, 'delete')!],
        ] as const;
        const includes = String.prototype.includes, add = Set.prototype.add, has = Set.prototype.has, remove = Set.prototype.delete;
        let searches = 0, receiverCharacterBudget = 0, additions = 0, lookups = 0, deletions = 0;
        // Plain native wrappers avoid counting Vitest mock bookkeeping as production Set operations.
        Object.defineProperty(String.prototype, 'includes', {...originals[0][2], value: function (this: string, ...args: Parameters<typeof includes>) {searches++; receiverCharacterBudget += this.length; return includes.apply(this, args);}});
        Object.defineProperty(Set.prototype, 'add', {...originals[1][2], value: function (this: Set<unknown>, value: unknown) {additions++; return add.call(this, value);}});
        Object.defineProperty(Set.prototype, 'has', {...originals[2][2], value: function (this: Set<unknown>, value: unknown) {lookups++; return has.call(this, value);}});
        Object.defineProperty(Set.prototype, 'delete', {...originals[3][2], value: function (this: Set<unknown>, value: unknown) {deletions++; return remove.call(this, value);}});
        let output: boolean, elapsedMs: number;
        try {
            const start = performance.now(); output = isLikelyPageContextLeak(origin, result, context); elapsedMs = performance.now() - start;
        } finally {
            for (const [prototype, key, descriptor] of originals) Object.defineProperty(prototype, key, descriptor);
        }
        const operations = {searches, receiverCharacterBudget, additions, lookups, deletions};
        const modulePath = (baseline ? process.env.AUDIT_E_BASELINE_SOURCE_ROOT! : root) + '/src/core/translation/prompts.ts';
        const proof = {function: 'isLikelyPageContextLeak', modulePath, productionSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'), inputSha256: createHash('sha256').update(context + '\0' + origin + '\0' + result).digest('hex'), characters: {context: context.length, origin: origin.length, result: result.length}, ...operations, elapsedMs, output, sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex')};
        writeFileSync(evidence + (baseline ? '/performance-baseline.json' : '/performance-current.json'), JSON.stringify(proof, null, 2));
        expect(output).toBe(false); expect(searches).toBeLessThanOrEqual(20);
        expect(isLikelyPageContextLeak('original', '甲乙丙丁戊己庚辛'.repeat(3), '甲乙丙丁戊己庚辛'.repeat(5))).toBe(true);
        expect(isDefinitePageContextLeak('literal <webpage_context>', 'literal <webpage_context>', 'reference')).toBe(false);
    });
});

describe('audit 49 E real Vue client model settings', () => {
    it('shows real download progress while keeping source controls and resource links out of the menu', async () => {
        vi.useFakeTimers(); entries.set('https://fluent-read.invalid/manga-model-source',new Response('mirror'));
        ports.message.mockResolvedValue({success:true,ready:false,bytes:0,source:'mirror',download:{phase:'downloading',file:'model.onnx',loaded:1048576,total:2097152,source:'hf-mirror.com'}});
        const {container} = await mount(MangaModelSettings);
        expect(container.querySelector('.manga-model-progress')!.textContent).toContain('50% · 1 / 2 MB');
        expect(container.querySelector('progress')!.getAttribute('value')).toBe('1048576');
        expect(container.querySelector('[aria-label="模型下载来源"]')).toBeNull();expect(container.querySelector('a')).toBeNull();
        expect(container.textContent).not.toMatch(/下载来源|hf-mirror|huggingface|ModelScope/u);
        expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='导入已下载文件')!.disabled).toBe(true);
    });
    it('ignores external legacy source status and cleans polling on repeated unmount', async () => {
        vi.useFakeTimers(); ports.message.mockResolvedValue({success: true, ready: true, bytes: 30, source: 'mirror'});
        for (let i = 0; i < 3; i++) {
            const {container, app} = await mount(MangaModelSettings, {showInpainting: false});
            expect(container.querySelector('[aria-label="模型下载来源"]')).toBeNull();
            expect(container.textContent).not.toContain('背景文字清除'); expect(container.querySelectorAll('a')).toHaveLength(0);
            app.unmount(); apps.delete(app); await settle(); expect(vi.getTimerCount()).toBe(0);
        }
    });
    it('recovers model status failures and removes resources using the actual controls', async () => {
        vi.useFakeTimers(); ports.message.mockRejectedValueOnce(new Error('unavailable'));
        const {container} = await mount(MangaModelSettings);
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('状态读取失败');
        ports.message.mockResolvedValue({success: true, ready: true, inpaintingReady: true, bytes: 1024, source: 'official'});
        await vi.advanceTimersByTimeAsync(1500); await settle(); expect(container.querySelector('[role="alert"]')).toBeNull();
        const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '清除已下载资源')!;
        remove.click(); await settle(); expect(ports.message).toHaveBeenCalledWith({type: 'fluentReadMangaModelRemove'});
        ports.message.mockResolvedValueOnce({success:false,error:'Failed to load https://hf-mirror.com/controlled-model.onnx'});
        remove.click();await settle();expect(container.querySelector('[role="alert"]')!.textContent).toBe('漫画识别模型清除失败');
        expect(container.textContent).not.toContain('hf-mirror');
    });
    it('keeps offline import usable and renders the actionable file validation failure', async () => {
        vi.useFakeTimers();
        const {container} = await mount(MangaModelSettings);
        const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;
        const click=vi.spyOn(input,'click');
        [...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='导入已下载文件')!.click();expect(click).toHaveBeenCalledOnce();
        Object.defineProperty(input,'files',{configurable:true,value:[{name:'unexpected.onnx',size:1}]});input.dispatchEvent(new Event('change'));await settle();
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('请选择配套的漫画模型文件');
        expect(ports.message).toHaveBeenCalledTimes(2);expect(input.value).toBe('');
    });
    it('does not subscribe or send OCR requests when the capability is unavailable', async () => {
        ports.imageOcr = false; const {container} = await mount(ImageOcrSettings);
        expect(container.textContent).toContain('当前浏览器暂不支持'); expect(ports.message).not.toHaveBeenCalled(); expect(ports.watch).not.toHaveBeenCalled();
    });
    it('downloads, removes and refreshes OCR language packs through real client buttons and stops watchers', async () => {
        vi.useFakeTimers(); const languages: string[] = [];
        ports.message.mockImplementation(async message => {
            if (message.type === 'fluentReadImageOcrDownload') languages.push(...message.languages);
            if (message.type === 'fluentReadImageOcrRemove') languages.splice(languages.indexOf(message.languages[0]), 1);
            return {success: true, languages: [...languages], states: {}};
        });
        const {container, app} = await mount(ImageOcrSettings, {sourceLanguage: 'en'});
        container.querySelector<HTMLButtonElement>('.image-ocr-primary-action')!.click(); await settle();
        expect(ports.message).toHaveBeenCalledWith({type: 'fluentReadImageOcrDownload', languages: ['eng']});
        expect(container.querySelector('[data-language="eng"]')!.getAttribute('data-state')).toBe('ready');
        container.querySelector<HTMLButtonElement>('.image-ocr-remove')!.click(); await settle(); expect(languages).toEqual([]);
        app.unmount(); apps.delete(app); expect(ports.stopWatch).toHaveBeenCalledOnce(); expect(progressEvents.removeListener).toHaveBeenCalledOnce(); expect(progressListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
    it('ignores an OCR response after the client is unmounted', async () => {
        vi.useFakeTimers(); const pending = deferred<unknown>(); ports.message.mockReturnValueOnce(pending.promise);
        const {app} = await mount(ImageOcrSettings); app.unmount(); apps.delete(app);
        pending.resolve({success: true, languages: ['eng'], states: {}}); await settle(); expect(vi.getTimerCount()).toBe(0); expect(ports.stopWatch).toHaveBeenCalledOnce(); expect(progressEvents.removeListener).toHaveBeenCalledOnce(); expect(progressListeners.size).toBe(0);
    });
    it('pauses OCR polling while hidden, coalesces visible refreshes and retries a failed status through the UI', async () => {
        vi.useFakeTimers(); ports.message.mockResolvedValueOnce({success: false});
        const {container} = await mount(ImageOcrSettings, {sourceLanguage: 'en', embedded: true, active: false});
        expect(container.querySelector('.image-ocr-engine-details')!.hasAttribute('open')).toBe(true);
        expect(container.querySelector('.image-ocr-language-details')!.hasAttribute('open')).toBe(true);
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('ocr.packs.statusError');
        const pending = deferred<unknown>(); ports.message.mockReturnValueOnce(pending.promise);
        container.querySelector<HTMLButtonElement>('.image-ocr-notice button')!.click(); await settle();
        document.dispatchEvent(new Event('visibilitychange')); ports.watch.mock.calls[0][1](); await settle();
        expect(ports.message).toHaveBeenCalledTimes(2);
        pending.resolve({success: true, languages: ['eng']}); await settle();
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.querySelector('.image-ocr-ready')!.textContent).toContain('ocr.packs.readyAction');
        (document as any).visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(6000); expect(ports.message).toHaveBeenCalledTimes(2);
        (document as any).visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await settle();
        expect(ports.message).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1500); expect(ports.message).toHaveBeenCalledTimes(4);
    });
    it('changes OCR source, manages optional packs and preserves explicit resource disclosure state', async () => {
        vi.useFakeTimers(); const sourceChanged = vi.fn();
        const {container, props} = await mount(ImageOcrSettings, {sourceLanguage: 'legacy-language', 'onUpdate:sourceLanguage': sourceChanged});
        expect(container.querySelector<HTMLButtonElement>('[data-option-value="legacy-language"]')!.disabled).toBe(true);
        container.querySelector<HTMLButtonElement>('[data-option-value="ja"]')!.click(); await settle(); expect(sourceChanged).toHaveBeenCalledWith('ja');
        props.sourceLanguage = 'ja'; await settle(); expect(container.querySelector('[data-language="jpn"]')).not.toBeNull();
        const count = container.querySelectorAll('[data-language]').length;
        container.querySelector<HTMLButtonElement>('.image-ocr-more')!.click(); await settle();
        expect(container.querySelectorAll('[data-language]').length).toBeGreaterThan(count);
        container.querySelector<HTMLButtonElement>('[data-language="eng"] .image-ocr-download-button')!.click(); await settle();
        expect(ports.message).toHaveBeenCalledWith({type: 'fluentReadImageOcrDownload', languages: ['eng']});
        container.querySelector<HTMLButtonElement>('.image-ocr-more')!.click(); await settle(); expect(container.querySelector('.image-ocr-more')!.getAttribute('aria-expanded')).toBe('false');
        props.embedded = true; props.active = false; await settle();
        const engine = container.querySelector<HTMLDetailsElement>('.image-ocr-engine-details')!, languages = container.querySelector<HTMLDetailsElement>('.image-ocr-language-details')!;
        expect(engine.hasAttribute('open')).toBe(false); expect(container.textContent).toContain('备用识别');
        for (const detail of [engine, languages]) {detail.open = true; detail.dispatchEvent(new Event('toggle'));} await settle();
        expect(engine.open).toBe(true); expect(languages.open).toBe(true);
        props.active = true; await settle(); expect(container.textContent).toContain('当前使用');
    });
    it('reports partial OCR download success without labeling installed packs as failures, then retries the failed pack', async () => {
        vi.useFakeTimers(); const languages: string[] = [], states: Record<string, {phase: string; error?: string}> = {};
        let attempt = 0;
        ports.message.mockImplementation(async message => {
            if (message.type === 'fluentReadImageOcrDownload') {
                if (attempt++ === 0) {languages.push('eng'); states.chi_sim = {phase: 'error', error: 'fixture missing Chinese pack'}; return {success: false, error: 'partial download'};}
                languages.push('chi_sim'); delete states.chi_sim;
            }
            return {success: true, languages: [...languages], states: {...states}};
        });
        const {container} = await mount(ImageOcrSettings, {sourceLanguage: 'zh-CN'});
        container.querySelector<HTMLButtonElement>('.image-ocr-primary-action')!.click(); await settle();
        expect(container.querySelector('[data-language="eng"] [role="alert"]')).toBeNull();
        expect(container.querySelector('[data-language="chi_sim"] [role="alert"]')!.textContent).toBe('fixture missing Chinese pack');
        container.querySelector<HTMLButtonElement>('[data-language="chi_sim"] .image-ocr-download-button')!.click(); await settle();
        expect(ports.message).toHaveBeenLastCalledWith({type: 'fluentReadImageOcrStatus'});
        expect(container.querySelector('[data-language="chi_sim"]')!.getAttribute('data-state')).toBe('ready');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    it('shows live OCR byte progress, removal failures and ignores late action failures after closing', async () => {
        vi.useFakeTimers(); let languages = ['eng']; const remove = deferred<unknown>();
        ports.message.mockImplementation(async message => message.type === 'fluentReadImageOcrRemove' ? remove.promise : {success: true, languages, states: {}});
        const {container, app} = await mount(ImageOcrSettings, {sourceLanguage: 'en'});
        const progressKey = 'fluentReadDownloadProgress:ocr-language:eng';
        for (const listener of progressListeners) listener({[progressKey]: {newValue: {loaded: 40, total: 100}}}, 'local'); await settle();
        expect(container.querySelector('progress')!.getAttribute('value')).toBe('40');
        expect(container.querySelector('.download-progress-detail')!.textContent).toBe('40%');
        container.querySelector<HTMLButtonElement>('.image-ocr-remove')!.click(); await settle();
        expect(container.querySelector('[data-language="eng"]')!.getAttribute('data-state')).toBe('removing');
        remove.resolve({success: false, error: 'fixture protected cache'}); await settle();
        expect(container.querySelector('[role="alert"]')!.textContent).toBe('fixture protected cache');
        for (const listener of progressListeners) listener({[progressKey]: {}}, 'local'); await settle();
        expect(container.querySelector('progress')).toBeNull();
        languages = []; ports.watch.mock.calls[0][1](); await settle();
        const pending = deferred<unknown>(); ports.message.mockImplementation(async message => message.type === 'fluentReadImageOcrDownload' ? pending.promise : {success: true, languages, states: {}});
        container.querySelector<HTMLButtonElement>('.image-ocr-primary-action')!.click(); await settle();
        app.unmount(); apps.delete(app); const count = ports.message.mock.calls.length;
        pending.reject(new Error('download failed after page close')); await settle();
        expect(ports.message).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
    });
    it('updates actual image and manga controls in the parent configuration and filters the site catalog', async () => {
        vi.useFakeTimers(); const settings = new Config(); settings.imageTranslationMangaEnabled = false; settings.useCache = true;
        const initialHover = settings.imageTranslationHoverEnabled, initialContextMenu = settings.imageTranslationContextMenuEnabled;
        const imageChanged = vi.fn();
        const {container, props} = await mount(MangaSettings, {settings, imageEnabled: false, available: true, serviceOptions: [{value: 'fixture', label: 'Fixture service'}], 'onUpdate:imageEnabled': imageChanged});
        for (const preview of container.querySelectorAll<HTMLElement>('.image-example')) {
            const buttons = preview.querySelectorAll<HTMLButtonElement>('.image-example-tabs button');
            buttons[0].click(); await settle(); expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
            expect(preview.textContent).toContain(preview.querySelector('.image-example-comic') ? 'Let’s explore a bigger world!' : 'Read. Discover a new perspective.');
            buttons[1].click(); await settle(); expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
            expect(preview.textContent).toContain(preview.querySelector('.image-example-comic') ? '一起去看看更大的世界吧！' : '阅读，发现新的视角');
        }
        const select = async (label: string, value: string) => {container.querySelector<HTMLButtonElement>(`[aria-label="${label}"] [data-option-value="${value}"]`)!.click(); await settle();};
        await select('area.settings.sourceLanguage', 'en'); await select('漫画目标语言', 'ja'); await select('漫画翻译服务', 'fixture'); await select('图片识别方式', 'tesseract');
        expect(props.settings).toMatchObject({from: 'en', to: 'ja', imageTranslationService: 'fixture', imageTranslationOcrEngine: 'tesseract'});
        container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="网页图片翻译"]')!.click(); await settle(); expect(imageChanged).toHaveBeenCalledWith(true);
        props.imageEnabled = true; await settle();
        for (const label of ['image.hover', 'image.context', '漫画连续翻译', '独立漫画按钮']) {container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!.click(); await settle();}
        await select('提前翻译后续页面', '5'); await select('快速缓存图片数量', '24');
        expect(props.settings).toMatchObject({imageTranslationHoverEnabled: !initialHover, imageTranslationContextMenuEnabled: !initialContextMenu, imageTranslationMangaEnabled: true, imageTranslationMangaPrefetchPages: 5, imageTranslationMangaCachePages: 24});
        const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.value = '  PiXiV  '; search.dispatchEvent(new Event('input', {bubbles: true})); await settle();
        expect(container.querySelectorAll('.manga-site')).toHaveLength(3);
        expect([...container.querySelectorAll('.manga-site')].every(site => site.textContent!.toLowerCase().includes('pixiv'))).toBe(true);
        search.value = 'no such fixture catalog site'; search.dispatchEvent(new Event('input', {bubbles: true})); await settle(); expect(container.textContent).toContain('没有匹配的网站');
        props.available = false; (props.settings as Config).useCache = false; await settle(); expect(container.querySelector('[data-settings-anchor="resources"]')).toBeNull();
    });
    it('rejects invalid manga URLs, selectors and a full rule list through the actual form', async () => {
        vi.useFakeTimers(); const settings = new Config(); settings.imageTranslationMangaSites = [];
        const {container, props} = await mount(MangaSettings, {settings, imageEnabled: false, available: true, serviceOptions: []});
        const submit = async (url: string, css: string) => {
            const address = container.querySelector<HTMLInputElement>('form input[type="url"]')!, selector = container.querySelector<HTMLInputElement>('form input[aria-label="漫画图片选择器"]')!;
            address.value = url; address.dispatchEvent(new Event('input', {bubbles: true})); selector.value = css; selector.dispatchEvent(new Event('input', {bubbles: true}));
            container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        };
        await submit('https://fixture.example/', ''); expect(container.querySelector('[role="alert"]')!.textContent).toContain('有效的阅读页地址');
        await submit('https://fixture.example/chapter/', 'img['); expect(container.querySelector('[role="alert"]')!.textContent).toContain('图片选择器无效');
        (props.settings as Config).imageTranslationMangaSites = Array.from({length: 20}, (_, i) => ({hostname: `fixture${i}.example`, pathPrefix: '/chapter/', selector: 'img'}));
        await submit('https://fixture.example/chapter/', 'main img'); expect(container.querySelector('[role="alert"]')!.textContent).toContain('最多添加 20');
        expect((props.settings as Config).imageTranslationMangaSites).toHaveLength(20);
    });
    it('adds and deletes validated manga rules via the actual rendered form and parent configuration', async () => {
        const settings = new Config(); settings.imageTranslationMangaSites = [];
        const {container, props} = await mount(MangaSettings, {settings, imageEnabled: false, available: true, serviceOptions: []});
        const address = container.querySelector<HTMLInputElement>('form input[aria-label="阅读页或阅读路径"]')!, selector = container.querySelector<HTMLInputElement>('form input[aria-label="漫画图片选择器"]')!;
        address.value = 'https://fixture.example/chapter/'; address.dispatchEvent(new Event('input', {bubbles: true}));
        selector.value = 'main img'; selector.dispatchEvent(new Event('input', {bubbles: true}));
        container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        expect((props.settings as typeof settings).imageTranslationMangaSites).toEqual([{hostname: 'fixture.example', pathPrefix: '/chapter/', selector: 'main img'}]);
        container.querySelector<HTMLButtonElement>('.manga-custom-site button')!.click(); await settle(); expect((props.settings as typeof settings).imageTranslationMangaSites).toEqual([]);
    });
});
